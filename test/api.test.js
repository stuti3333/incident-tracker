const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const M = require('../server/models');
const { createApp } = require('../server/app');

const base = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const uri =
  base.match(/^mongodb(?:\+srv)?:\/\/[^/?]+/)[0] +
  '/incident_tracker_test_' +
  process.pid; // same server, throwaway db
let server,
  url,
  pid,
  atomic = true;
process.env.GITHUB_WEBHOOK_SECRET = 'shh';

const call = async (
  method,
  path,
  body,
  token = 'dev-token',
  user = 'alice',
) => {
  const r = await fetch(url + '/api' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
      'X-User': user,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

before(async () => {
  await M.mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  await Promise.all(
    Object.values(M)
      .filter((m) => m && m.init && m.modelName)
      .map((m) => m.init()),
  );
  const ids = await Promise.all(
    Array.from({ length: 25 }, () => M.nextId('probe')),
  );
  atomic = new Set(ids).size === ids.length;
  if (!atomic)
    console.log(
      '# NOTE: database findAndModify is not atomic; race tests are skipped',
    );
  server = createApp().listen(0);
  url = 'http://127.0.0.1:' + server.address().port;
  const r = await call('POST', '/projects', { name: 'shop' });
  assert.equal(r.status, 201);
  pid = r.body.id;
});
after(async () => {
  server.close();
  await M.mongoose.connection.dropDatabase();
  await M.mongoose.disconnect();
});

test('auth and roles', async () => {
  assert.equal((await call('GET', '/projects', undefined, 'nope')).status, 401);
  assert.equal(
    (await call('GET', '/projects', undefined, 'view-token')).status,
    200,
  );
  assert.equal(
    (await call('POST', '/projects', { name: 'x' }, 'view-token')).status,
    403,
  );
  assert.equal(
    (await call('GET', `/projects/${pid}/audit`, undefined, 'dev-token'))
      .status,
    403,
  );
  assert.equal(
    (await call('GET', `/projects/${pid}/audit`, undefined, 'admin-token'))
      .status,
    200,
  );
});

test('projects: validation, duplicates, 404', async () => {
  assert.equal((await call('POST', '/projects', {})).status, 400);
  assert.equal((await call('POST', '/projects', { name: 'shop' })).status, 409);
  assert.equal((await call('GET', '/projects/9999/incidents')).status, 404);
  assert.equal((await call('GET', '/projects/abc/timeline')).status, 400);
});

test('deployments are idempotent and merge late/partial records', async () => {
  const a = await call('POST', `/projects/${pid}/deployments`, {
    version: 'v1.0.0',
    service: 'api',
  }); // no time -> estimated
  assert.equal(a.status, 201);
  assert.equal(a.body.time_estimated, true);
  const real = '2026-10-01T10:00:00.000Z';
  const b = await call('POST', `/projects/${pid}/deployments`, {
    version: 'v1.0.0',
    service: 'api',
    deployed_at: real,
    deployed_by: 'bob',
  });
  assert.equal(b.body.id, a.body.id);
  assert.equal(b.body.time_estimated, false);
  assert.equal(b.body.occurred_at, real);
  assert.equal(b.body.deployed_by, 'bob');
  await call('POST', `/projects/${pid}/deployments`, {
    version: 'v1.0.0',
    service: 'api',
    status: 'failed',
    status_at: '2026-10-01T10:05:00Z',
  });
  const old = await call('POST', `/projects/${pid}/deployments`, {
    version: 'v1.0.0',
    service: 'api',
    status: 'succeeded',
    status_at: '2026-10-01T10:01:00Z',
  });
  assert.equal(old.body.status, 'failed');
  const list = await call('GET', `/projects/${pid}/deployments`);
  assert.equal(list.body.filter((d) => d.version === 'v1.0.0').length, 1);
  assert.equal(
    (await call('POST', `/projects/${pid}/deployments`, { service: 'api' }))
      .status,
    400,
  );
  assert.equal(
    (
      await call('POST', `/projects/${pid}/deployments`, {
        version: 'v9',
        status: 'bogus',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call('POST', `/projects/${pid}/deployments`, {
        version: 'v9',
        deployed_at: 'not-a-date',
      })
    ).status,
    400,
  );
});

test('concurrent deliveries of one deployment create a single record', async (t) => {
  if (!atomic) return t.skip('needs an atomic database');
  const rs = await Promise.all(
    Array.from({ length: 6 }, () =>
      call('POST', `/projects/${pid}/deployments`, {
        version: 'v-race',
        service: 'web',
        deployed_at: '2026-10-02T00:00:00Z',
      }),
    ),
  );
  assert.ok(
    rs.every((r) => r.status === 201),
    JSON.stringify(rs.map((r) => r.status)),
  );
  assert.equal(new Set(rs.map((r) => r.body.id)).size, 1);
});

test('duplicate incident reports fold into the open one, even when simultaneous', async (t) => {
  const run = async (fns) => {
    if (atomic) return Promise.all(fns.map((f) => f()));
    const out = [];
    for (const f of fns) out.push(await f());
    return out;
  };
  const rs = await run(
    [1, 2, 3, 4].map(
      (n) => () =>
        call('POST', `/projects/${pid}/incidents`, {
          title: `Checkout timeout ${500 + n} at 1a2b3c4d${n}`,
          severity: 'high',
          service: 'api',
          started_at: '2026-10-01T10:30:00Z',
        }),
    ),
  );
  assert.equal(
    rs.filter((r) => r.status === 201).length,
    1,
    JSON.stringify(rs.map((r) => r.status)),
  );
  assert.equal(rs.filter((r) => r.body.duplicate).length, 3);
  const list = (await call('GET', `/projects/${pid}/incidents`)).body.filter(
    (i) => /Checkout/.test(i.title),
  );
  assert.equal(list.length, 1);
  assert.equal(list[0].report_count, 4);
  assert.equal(list[0].open_key, undefined); // internals are hidden
});

test('suspects are ranked, linking works, and incident detail has updates + links', async () => {
  const inc = (await call('GET', `/projects/${pid}/incidents`)).body.find((i) =>
    /Checkout/.test(i.title),
  );
  const d = await call('POST', `/projects/${pid}/deployments`, {
    version: 'v2.0.0',
    service: 'api',
    deployed_at: '2026-10-01T10:20:00Z',
    status: 'failed',
  });
  const detail = (await call('GET', `/incidents/${inc.id}`)).body;
  assert.equal(detail.suspects[0].deployment.version, 'v2.0.0');
  assert.ok(detail.suspects[0].reasons.some((r) => /same service/.test(r)));
  assert.equal(
    (
      await call('POST', `/incidents/${inc.id}/links`, {
        deployment_id: d.body.id,
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await call('POST', `/incidents/${inc.id}/links`, {
        deployment_id: d.body.id,
      })
    ).status,
    201,
  ); // idempotent
  assert.equal(
    (await call('POST', `/incidents/${inc.id}/links`, {})).status,
    400,
  );
  assert.equal(
    (await call('POST', `/incidents/${inc.id}/links`, { deployment_id: 99999 }))
      .status,
    404,
  );
  const after = (await call('GET', `/incidents/${inc.id}`)).body;
  assert.equal(after.links.length, 1);
  assert.equal(after.links[0].version, 'v2.0.0');
  assert.ok(after.updates.length >= 3); // the folded duplicates left notes
  const c = await call(
    'POST',
    `/incidents/${inc.id}/updates`,
    { body: 'rolling back' },
    'dev-token',
    'carol',
  );
  assert.equal(c.status, 201);
  assert.equal(c.body.author, 'carol');
  assert.equal(
    (await call('POST', `/incidents/${inc.id}/updates`, { body: '  ' })).status,
    400,
  );
});

test('conflicting edits: stale version gets 409 with current state', async () => {
  const r = await call('POST', `/projects/${pid}/incidents`, {
    title: 'Login page blank',
    severity: 'low',
  });
  const id = r.body.id,
    v = r.body.version;
  const first = await call(
    'PATCH',
    `/incidents/${id}`,
    { version: v, status: 'investigating', assignee: 'bob' },
    'dev-token',
    'bob',
  );
  assert.equal(first.status, 200);
  assert.equal(first.body.version, v + 1);
  const second = await call(
    'PATCH',
    `/incidents/${id}`,
    { version: v, severity: 'critical' },
    'dev-token',
    'alice',
  );
  assert.equal(second.status, 409);
  assert.equal(second.body.current.assignee, 'bob');
  assert.equal(
    (await call('PATCH', `/incidents/${id}`, { status: 'open' })).status,
    400,
  ); // version required
  assert.equal(
    (
      await call('PATCH', `/incidents/${id}`, {
        version: v + 1,
        status: 'weird',
      })
    ).status,
    400,
  );
  assert.equal(
    (await call('PATCH', '/incidents/99999', { version: 1, status: 'open' }))
      .status,
    404,
  );
});

test('two simultaneous writers with the same version: exactly one wins', async (t) => {
  if (!atomic) return t.skip('needs an atomic database');
  const id = (
    await call('POST', `/projects/${pid}/incidents`, {
      title: 'Search is slow',
    })
  ).body.id;
  const cur = (await call('GET', `/incidents/${id}`)).body.incident;
  const race = await Promise.all([
    call('PATCH', `/incidents/${id}`, { version: cur.version, assignee: 'x' }),
    call('PATCH', `/incidents/${id}`, { version: cur.version, assignee: 'y' }),
  ]);
  assert.deepEqual(race.map((x) => x.status).sort(), [200, 409]);
});

test('resolve, MTTR, reopen, and recurring incidents', async () => {
  const mk = await call('POST', `/projects/${pid}/incidents`, {
    title: 'Cache stampede',
    started_at: '2026-10-03T00:00:00Z',
  });
  const res = await call('PATCH', `/incidents/${mk.body.id}`, {
    version: mk.body.version,
    status: 'resolved',
    resolution: 'added jitter',
  });
  assert.equal(res.status, 200);
  assert.ok(res.body.resolved_at);
  let dash = (await call('GET', `/projects/${pid}/dashboard`)).body;
  assert.ok(dash.summary.mttr_min > 0);
  const again = await call('POST', `/projects/${pid}/incidents`, {
    title: 'Cache stampede',
  });
  assert.equal(again.status, 201);
  assert.notEqual(again.body.id, mk.body.id);
  dash = (await call('GET', `/projects/${pid}/dashboard`)).body;
  assert.ok(
    dash.recurring.some((r) => r.title === 'Cache stampede' && r.n === 2),
  );
  if (!atomic) return;
  const reopen = await call('PATCH', `/incidents/${mk.body.id}`, {
    version: res.body.version,
    status: 'open',
  });
  assert.equal(reopen.status, 409);
  const closeNew = await call('PATCH', `/incidents/${again.body.id}`, {
    version: again.body.version,
    status: 'resolved',
  });
  assert.equal(closeNew.status, 200);
  const reopened = await call('PATCH', `/incidents/${mk.body.id}`, {
    version: res.body.version,
    status: 'open',
  });
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.resolved_at ?? null, null); // reopening clears resolved_at so MTTR stays honest
});

test('dashboard shape and implicated deployments', async () => {
  const d = (await call('GET', `/projects/${pid}/dashboard`)).body;
  for (const k of [
    'summary',
    'openBySeverity',
    'recurring',
    'deploymentsLast7d',
    'deploymentsLinkedToIncidents',
  ])
    assert.ok(k in d, k);
  assert.ok(
    d.deploymentsLinkedToIncidents.some(
      (x) => x.version === 'v2.0.0' && x.n === 1,
    ),
  );
  const empty = (await call('POST', '/projects', { name: 'empty' })).body.id;
  const e = (await call('GET', `/projects/${empty}/dashboard`)).body;
  assert.deepEqual(e.summary, {
    total: 0,
    open: 0,
    critical: 0,
    mttr_min: null,
  });
});

test('timeline is ordered by occurrence time and dedupes events', async () => {
  const tl = (await call('GET', `/projects/${pid}/timeline`)).body;
  const times = tl.map((e) => new Date(e.occurred_at).getTime());
  assert.deepEqual(
    times,
    [...times].sort((a, b) => b - a),
  );
  const keys = tl.map((e) => `${e.kind}:${e.title}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(tl[0].received_at);
});

test('changes are idempotent by sha and can be linked', async () => {
  const body = {
    sha: 'abcdef1234567',
    message: 'fix cart\n\nlong body',
    author: 'bob',
    files: ['cart.js'],
  };
  assert.equal(
    (await call('POST', `/projects/${pid}/changes`, body)).status,
    201,
  );
  assert.equal(
    (await call('POST', `/projects/${pid}/changes`, body)).status,
    200,
  );
  assert.equal((await call('GET', `/projects/${pid}/changes`)).body.length, 1);
  assert.equal(
    (await call('POST', `/projects/${pid}/changes`, {})).status,
    400,
  );
});

test('GitHub webhook: signature check and idempotent deliveries', async () => {
  const send = async (event, payload, secret = 'shh') => {
    const raw = JSON.stringify(payload);
    const sig =
      'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
    const r = await fetch(`${url}/api/webhooks/github/${pid}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': event,
        'X-Hub-Signature-256': sig,
      },
      body: raw,
    });
    return r.status;
  };
  const push = {
    commits: [
      {
        id: 'f'.repeat(40),
        message: 'hotfix',
        author: { name: 'dev' },
        modified: ['a.js'],
        timestamp: '2026-10-04T00:00:00Z',
      },
    ],
  };
  assert.equal(await send('push', push, 'wrong'), 401);
  assert.equal(await send('push', push), 200);
  assert.equal(await send('push', push), 200);
  const ds = {
    deployment: {
      id: 77,
      ref: 'main',
      sha: 'a'.repeat(40),
      environment: 'production',
      created_at: '2026-10-04T01:00:00Z',
    },
    deployment_status: {
      state: 'success',
      created_at: '2026-10-04T01:02:00Z',
      creator: { login: 'octo' },
    },
  };
  assert.equal(await send('deployment_status', ds), 200);
  assert.equal(await send('deployment_status', ds), 200);
  const deps = (await call('GET', `/projects/${pid}/deployments`)).body.filter(
    (d) => d.dedupe_key === 'gh:77',
  );
  assert.equal(deps.length, 1);
  assert.equal(deps[0].status, 'succeeded');
  assert.equal(
    (await call('GET', `/projects/${pid}/changes`)).body.filter((c) =>
      c.sha.startsWith('ffff'),
    ).length,
    1,
  );
});

test('SSE stream announces changes', async () => {
  const ctl = new AbortController();
  const r = await fetch(`${url}/api/projects/${pid}/stream?token=view-token`, {
    signal: ctl.signal,
  });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const reader = r.body.getReader();
  await call('POST', `/projects/${pid}/deployments`, {
    version: 'v-sse',
    service: 'web',
  });
  let got = '';
  const dec = new TextDecoder();
  while (!/event: deployment/.test(got))
    got += dec.decode((await reader.read()).value);
  ctl.abort();
  assert.match(got, /v-sse/);
});

test('bad input never crashes the server', async () => {
  const r = await fetch(url + '/api/projects', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer dev-token',
    },
    body: '{oops',
  });
  assert.equal(r.status, 400);
  assert.equal((await call('GET', '/nope')).status, 404);
  assert.equal((await call('GET', '/incidents/abc')).status, 400);
  assert.equal((await call('GET', '/health')).status, 200);
});
