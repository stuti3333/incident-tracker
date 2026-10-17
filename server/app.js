// Express REST API + Server-Sent Events. Same contract as the React client in ../client expects.
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const M = require('./models');
const { mongoose, nextId, SEVERITIES, STATUSES, DEPLOY_STATUSES } = M;

// ---------- small helpers ----------
const httpError = (status, message, extra) => Object.assign(new Error(message), { status, ...extra });
const h = f => (req, res, next) => Promise.resolve(f(req, res, next)).catch(next);
const isDup = e => e && (e.code === 11000 || e.code === 11001);
// If the _id itself collides (counter behind the data, e.g. after a manual import) take the next number and retry;
// a collision on any other unique key is a real duplicate and is left to the caller.
const idClash = e => isDup(e) && (e.keyPattern ? '_id' in e.keyPattern : /\b_id\b/.test(e.message || ''));
const create = async (Model, counter, fields) => {
  for (let attempt = 0; ; attempt++) {
    try { return await new Model({ _id: await nextId(counter), ...fields }).save(); }
    catch (e) { if (!idClash(e) || attempt >= 5) throw e; }
  }
};
const intId = (v, what = 'id') => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw httpError(400, `invalid ${what}`);
  return n;
};
const toDate = (v, what, fallback) => {
  if (v == null || v === '') return fallback;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw httpError(400, `${what} is not a valid date`);
  return d;
};
const str = v => (typeof v === 'string' && v.trim() ? v.trim() : null);
const json = docs => (Array.isArray(docs) ? docs.map(d => d.toJSON()) : docs.toJSON());
// "Timeout 502 at 1a2b3c4d" and "Timeout 503 at ffee1234" describe the same failure
const fingerprint = t => t.toLowerCase().replace(/[0-9a-f]{7,}|\d+/g, '#').replace(/\s+/g, ' ').trim();

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { req.raw = buf; } }));

  // ---------- realtime (SSE), audit log, timeline ----------
  const subs = new Map();
  const emit = (pid, type, data) => {
    for (const r of subs.get(String(pid)) || []) r.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const audit = (pid, actor, action, entity, id, detail) =>
    create(M.AuditLog, 'audit', { project_id: pid, actor, action, entity, entity_id: id, detail: detail || {} });
  // Idempotent: the same dedupe_key can be sent any number of times and lands on the timeline once.
  async function addEvent(pid, kind, ref, title, at, key, actor) {
    if (await M.Event.exists({ project_id: pid, dedupe_key: key })) return;
    try {
      await create(M.Event, 'event', { project_id: pid, kind, ref_id: ref, title, occurred_at: at, dedupe_key: key, actor });
    } catch (e) { if (!isDup(e)) throw e; }
  }

  // ---------- health (public) and readiness ----------
  app.get('/api/health', (_req, res) => res.json({ ok: mongoose.connection.readyState === 1, db: mongoose.connection.readyState === 1 ? 'up' : 'down' }));
  app.use('/api', (_req, _res, next) => {
    if (mongoose.connection.readyState !== 1) return next(httpError(503, 'Cannot reach the database. Check that MongoDB is running and MONGODB_URI is correct.'));
    next();
  });

  // ---------- auth / RBAC: bearer token -> role (viewer < developer < admin) ----------
  const TOK = Object.fromEntries((process.env.TOKENS || 'admin-token:admin,dev-token:developer,view-token:viewer')
    .split(',').map(s => s.trim().split(':')));
  const RANK = { viewer: 1, developer: 2, admin: 3 };
  const need = min => (req, _res, next) =>
    RANK[req.role] >= RANK[min] ? next() : next(httpError(403, `requires ${min} role`));
  app.use('/api', (req, _res, next) => {
    if (req.path.startsWith('/webhooks') || req.path === '/health') return next();
    const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.query.token;
    req.role = Object.prototype.hasOwnProperty.call(TOK, t) ? TOK[t] : undefined;
    if (!req.role) return next(httpError(401, 'invalid token'));
    req.user = String(req.headers['x-user'] || req.query.user || req.role).slice(0, 60);
    next();
  });

  const projectOf = async id => {
    const p = await M.Project.findById(intId(id, 'project id'));
    if (!p) throw httpError(404, 'project not found');
    return p;
  };

  // ---------- projects ----------
  app.get('/api/projects', h(async (_req, res) => res.json(json(await M.Project.find().sort({ _id: -1 })))));
  app.post('/api/projects', need('developer'), h(async (req, res) => {
    const name = str(req.body.name);
    if (!name) throw httpError(400, 'name required');
    let p;
    try { p = await create(M.Project, 'project', { name, repo_url: str(req.body.repo_url) }); }
    catch (e) { throw isDup(e) ? httpError(409, 'A project with that name already exists') : e; }
    await audit(p.id, req.user, 'project.create', 'project', p.id, p.toJSON());
    res.status(201).json(p.toJSON());
  }));

  // ---------- deployments ----------
  // Idempotent upsert. Late or partial records fill gaps, the newest status observation wins, and a real
  // deploy time replaces an estimated one. Merged with compare-and-set on `rev`, so two concurrent
  // deliveries of the same deployment cannot lose each other's data.
  async function upsertDeployment(pid, d, actor) {
    const version = str(d.version);
    if (!version) throw httpError(400, 'version required');
    const status = d.status || 'succeeded';
    if (!DEPLOY_STATUSES.includes(status)) throw httpError(400, `status must be one of ${DEPLOY_STATUSES.join(', ')}`);
    const now = new Date();
    const deployedAt = toDate(d.deployed_at, 'deployed_at');
    const inc = {
      service: str(d.service), deployed_by: str(d.deployed_by),
      environment: str(d.environment) || 'production', status,
      status_at: toDate(d.status_at, 'status_at', deployedAt || now),
      commit_shas: Array.isArray(d.commit_shas) ? d.commit_shas.map(String) : [],
      occurred_at: deployedAt || now, time_estimated: !deployedAt
    };
    const key = str(d.dedupe_key) || `${inc.environment}:${inc.service || 'app'}:${version}`;

    let row = null;
    for (let attempt = 0; attempt < 6 && !row; attempt++) {
      const cur = await M.Deployment.findOne({ project_id: pid, dedupe_key: key });
      if (!cur) {
        try { row = await create(M.Deployment, 'deployment', { project_id: pid, dedupe_key: key, version, ...inc }); }
        catch (e) { if (!isDup(e)) throw e; }   // lost a race with a concurrent insert: merge on the next pass
        continue;
      }
      // a status with a real timestamp outranks one recorded without a time (its status_at is only the arrival time)
      const newer = inc.status_at >= cur.status_at || (cur.time_estimated && !inc.time_estimated);
      const merged = {
        service: inc.service ?? cur.service,
        deployed_by: inc.deployed_by ?? cur.deployed_by,
        commit_shas: inc.commit_shas.length ? inc.commit_shas : cur.commit_shas,
        status: newer ? inc.status : cur.status,
        status_at: newer ? inc.status_at : cur.status_at,
        occurred_at: cur.time_estimated && !inc.time_estimated ? inc.occurred_at : cur.occurred_at,
        time_estimated: cur.time_estimated && inc.time_estimated
      };
      row = await M.Deployment.findOneAndUpdate({ _id: cur._id, rev: cur.rev }, { $set: merged, $inc: { rev: 1 } }, { new: true });
    }
    if (!row) throw httpError(503, 'deployment is being updated concurrently, retry');
    await addEvent(pid, 'deployment', row.id, `Deploy ${row.version} to ${row.environment}: ${row.status}`, row.occurred_at, `deployment:${row.id}:${row.status}`, actor);
    await audit(pid, actor, 'deployment.upsert', 'deployment', row.id, d);
    emit(pid, 'deployment', row.toJSON());
    return row.toJSON();
  }
  app.post('/api/projects/:id/deployments', need('developer'), h(async (req, res) => {
    const p = await projectOf(req.params.id);
    res.status(201).json(await upsertDeployment(p.id, req.body, req.user));
  }));
  app.get('/api/projects/:id/deployments', h(async (req, res) => {
    const p = await projectOf(req.params.id);
    res.json(json(await M.Deployment.find({ project_id: p.id }).sort({ occurred_at: -1, _id: -1 }).limit(100)));
  }));

  // ---------- changes (commits) ----------
  async function upsertChange(pid, c, actor) {
    const sha = str(c.sha);
    if (!sha) throw httpError(400, 'sha required');
    let row;
    try {
      row = await create(M.Change, 'change', {
        project_id: pid, sha, message: c.message, author: c.author,
        files: Array.isArray(c.files) ? c.files.map(String) : [], committed_at: toDate(c.committed_at, 'committed_at', new Date())
      });
    } catch (e) {
      if (isDup(e)) return { duplicate: true };
      throw e;
    }
    await addEvent(pid, 'change', row.id, `Commit ${row.sha.slice(0, 7)}: ${(row.message || '').split('\n')[0]}`, row.committed_at, `change:${row.sha}`, actor);
    await audit(pid, actor, 'change.create', 'change', row.id, { sha: row.sha });
    emit(pid, 'change', row.toJSON());
    return row.toJSON();
  }
  app.post('/api/projects/:id/changes', need('developer'), h(async (req, res) => {
    const p = await projectOf(req.params.id);
    const r = await upsertChange(p.id, req.body, req.user);
    res.status(r.duplicate ? 200 : 201).json(r);
  }));
  app.get('/api/projects/:id/changes', h(async (req, res) => {
    const p = await projectOf(req.params.id);
    res.json(json(await M.Change.find({ project_id: p.id }).sort({ committed_at: -1, _id: -1 }).limit(100)));
  }));

  // ---------- incidents ----------
  const SEV_RANK = Object.fromEntries([...SEVERITIES].reverse().map((s, i) => [s, i]));
  app.get('/api/projects/:id/incidents', h(async (req, res) => {
    const p = await projectOf(req.params.id);
    const all = await M.Incident.find({ project_id: p.id }).sort({ started_at: -1, _id: -1 }).limit(500);
    // open first, then by severity, then newest onset (the stable sort keeps the DB order within ties)
    all.sort((a, b) => (a.status === 'resolved') - (b.status === 'resolved') || SEV_RANK[a.severity] - SEV_RANK[b.severity]);
    res.json(json(all));
  }));

  async function foldDuplicate(inc, title, user) {
    const updated = await M.Incident.findOneAndUpdate({ _id: inc._id }, { $inc: { report_count: 1 } }, { new: true });
    await create(M.IncidentUpdate, 'incident_update', { incident_id: inc.id, author: user, body: `Duplicate report merged: ${title}` });
    await audit(inc.project_id, user, 'incident.duplicate', 'incident', inc.id, { title });
    emit(inc.project_id, 'incident', updated.toJSON());
    return updated.toJSON();
  }
  app.post('/api/projects/:id/incidents', need('developer'), h(async (req, res) => {
    const p = await projectOf(req.params.id), b = req.body, pid = p.id;
    const title = str(b.title);
    if (!title) throw httpError(400, 'title required');
    const severity = b.severity || 'medium';
    if (!SEVERITIES.includes(severity)) throw httpError(400, `severity must be one of ${SEVERITIES.join(', ')}`);
    const fp = fingerprint(title), openKey = `${pid}:${fp}`;

    // duplicate report: fold into the open incident that has the same fingerprint
    const dup = await M.Incident.findOne({ open_key: openKey });
    if (dup) return res.status(200).json({ duplicate: true, incident: await foldDuplicate(dup, title, req.user) });

    let i;
    try {
      i = await create(M.Incident, 'incident', {
        project_id: pid, title, fingerprint: fp, open_key: openKey, service: str(b.service), severity,
        assignee: str(b.assignee), started_at: toDate(b.started_at, 'started_at', new Date()), created_by: req.user
      });
    } catch (e) {
      if (!isDup(e)) throw e;
      // two reports raced: the other one won the unique index, so merge into it
      const winner = await M.Incident.findOne({ open_key: openKey });
      if (!winner) throw e;
      return res.status(200).json({ duplicate: true, incident: await foldDuplicate(winner, title, req.user) });
    }
    await addEvent(pid, 'incident', i.id, `Incident #${i.id} (${i.severity}): ${i.title}`, i.started_at, `incident:${i.id}:created`, req.user);
    await audit(pid, req.user, 'incident.create', 'incident', i.id, b);
    emit(pid, 'incident', i.toJSON());
    res.status(201).json(i.toJSON());
  }));

  // Optimistic locking: the client sends the version it loaded; a stale write gets 409 plus the current state.
  app.patch('/api/incidents/:id', need('developer'), h(async (req, res) => {
    const id = intId(req.params.id, 'incident id');
    const { version, ...f } = req.body;
    const set = {};
    for (const k of ['title', 'status', 'severity', 'assignee', 'resolution', 'service']) {
      if (!(k in f)) continue;
      set[k] = str(f[k]);
    }
    if (!Number.isInteger(version) || !Object.keys(set).length) throw httpError(400, 'version (integer) and at least one field required');
    if ('title' in set && !set.title) throw httpError(400, 'title cannot be empty');
    if ('status' in set && !STATUSES.includes(set.status)) throw httpError(400, `status must be one of ${STATUSES.join(', ')}`);
    if ('severity' in set && !SEVERITIES.includes(set.severity)) throw httpError(400, `severity must be one of ${SEVERITIES.join(', ')}`);

    const stale = async cur => {
      throw httpError(409, 'stale version: incident changed since you loaded it', { current: cur && cur.toJSON() });
    };
    const cur = await M.Incident.findById(id);
    if (!cur) throw httpError(404, 'incident not found');
    if (cur.version !== version) await stale(cur);

    const now = new Date();
    const unset = {};
    if (set.status === 'resolved') { set.resolved_at = cur.resolved_at || now; unset.open_key = 1; }
    else if (set.status && cur.status === 'resolved') { set.resolved_at = null; set.open_key = `${cur.project_id}:${cur.fingerprint}`; } // reopened
    set.updated_at = now;

    let i;
    try {
      i = await M.Incident.findOneAndUpdate({ _id: id, version }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}), $inc: { version: 1 } }, { new: true });
    } catch (e) {
      if (isDup(e)) throw httpError(409, 'Another open incident with the same failure already exists; merge into it instead of reopening this one.');
      throw e;
    }
    if (!i) await stale(await M.Incident.findById(id));
    const changed = Object.keys(f).filter(k => k !== 'version');
    await addEvent(i.project_id, 'incident', i.id, `Incident #${i.id} updated: ${changed.join(', ')}`, now, `incident:${i.id}:v${i.version}`, req.user);
    await audit(i.project_id, req.user, 'incident.update', 'incident', i.id, f);
    emit(i.project_id, 'incident', i.toJSON());
    res.json(i.toJSON());
  }));

  app.post('/api/incidents/:id/updates', need('developer'), h(async (req, res) => {
    const body = str(req.body.body);
    if (!body) throw httpError(400, 'body required');
    const i = await M.Incident.findById(intId(req.params.id, 'incident id'));
    if (!i) throw httpError(404, 'incident not found');
    const u = await create(M.IncidentUpdate, 'incident_update', { incident_id: i.id, author: req.user, body });
    await addEvent(i.project_id, 'update', i.id, `${req.user} on #${i.id}: ${body.slice(0, 80)}`, u.created_at, `update:${u.id}`, req.user);
    await audit(i.project_id, req.user, 'incident.comment', 'incident', i.id, { update: u.id });
    emit(i.project_id, 'incident', i.toJSON());
    res.status(201).json(u.toJSON());
  }));

  app.post('/api/incidents/:id/links', need('developer'), h(async (req, res) => {
    const i = await M.Incident.findById(intId(req.params.id, 'incident id'));
    if (!i) throw httpError(404, 'incident not found');
    const dep = req.body.deployment_id == null ? null : intId(req.body.deployment_id, 'deployment_id');
    const chg = req.body.change_id == null ? null : intId(req.body.change_id, 'change_id');
    if ((dep == null) === (chg == null)) throw httpError(400, 'provide exactly one of deployment_id or change_id');
    const target = dep != null ? await M.Deployment.findById(dep) : await M.Change.findById(chg);
    if (!target || target.project_id !== i.project_id) throw httpError(404, `${dep != null ? 'deployment' : 'change'} not found in this project`);
    try {
      await create(M.IncidentLink, 'incident_link', { incident_id: i.id, deployment_id: dep, change_id: chg, note: str(req.body.note), linked_by: req.user });
    } catch (e) { if (!isDup(e)) throw e; }   // linking twice is harmless
    const label = dep != null ? `deployment ${target.version}` : `commit ${target.sha.slice(0, 7)}`;
    await addEvent(i.project_id, 'link', i.id, `${req.user} linked ${label} to incident #${i.id}`, new Date(), `link:${i.id}:${dep ?? ''}:${chg ?? ''}`, req.user);
    await audit(i.project_id, req.user, 'incident.link', 'incident', i.id, req.body);
    emit(i.project_id, 'incident', i.toJSON());
    res.status(201).json({ ok: true });
  }));

  // ---------- failure <-> deployment correlation ----------
  async function suspects(inc) {
    const start = inc.started_at.getTime();
    const deps = await M.Deployment.find({
      project_id: inc.project_id, occurred_at: { $gte: new Date(start - 48 * 36e5), $lte: new Date(start + 5 * 6e4) }
    });
    // which services were blamed for earlier incidents with the same failure fingerprint?
    const earlier = await M.Incident.find({ project_id: inc.project_id, fingerprint: inc.fingerprint, _id: { $ne: inc._id } }, '_id');
    const past = new Map();
    if (earlier.length) {
      const links = await M.IncidentLink.find({ incident_id: { $in: earlier.map(e => e._id) }, deployment_id: { $ne: null } });
      const blamed = await M.Deployment.find({ _id: { $in: links.map(l => l.deployment_id) } }, 'service');
      const svc = new Map(blamed.map(d => [d._id, d.service]));
      const seen = new Map();
      for (const l of links) {
        const s = svc.get(l.deployment_id);
        if (!s) continue;
        if (!seen.has(s)) seen.set(s, new Set());
        seen.get(s).add(l.incident_id);
      }
      for (const [s, set] of seen) past.set(s, set.size);
    }
    return deps.map(d => {
      const hrs = Math.max((start - d.occurred_at.getTime()) / 36e5, 0), why = [`deployed ${hrs.toFixed(1)}h before onset`];
      let s = Math.exp(-hrs / 6) * 0.55;
      if (inc.service && d.service === inc.service) { s += 0.2; why.push('same service'); }
      if (d.environment === 'production') { s += 0.1; why.push('production'); }
      if (d.status === 'failed' || d.status === 'rolled_back') { s += 0.15; why.push(d.status); }
      if (d.service && past.get(d.service)) { s += 0.1; why.push(`service blamed in ${past.get(d.service)} earlier similar incident(s)`); }
      if (d.time_estimated) { s -= 0.1; why.push('deploy time estimated'); }
      return { deployment: d.toJSON(), score: +Math.max(s, 0).toFixed(2), reasons: why };
    }).sort((a, b) => b.score - a.score).slice(0, 5);
  }

  app.get('/api/incidents/:id', h(async (req, res) => {
    const i = await M.Incident.findById(intId(req.params.id, 'incident id'));
    if (!i) throw httpError(404, 'incident not found');
    const [updates, rawLinks, sus] = await Promise.all([
      M.IncidentUpdate.find({ incident_id: i.id }).sort({ created_at: 1, _id: 1 }),
      M.IncidentLink.find({ incident_id: i.id }).sort({ _id: 1 }),
      suspects(i)
    ]);
    const [deps, chgs] = await Promise.all([
      M.Deployment.find({ _id: { $in: rawLinks.map(l => l.deployment_id).filter(x => x != null) } }),
      M.Change.find({ _id: { $in: rawLinks.map(l => l.change_id).filter(x => x != null) } })
    ]);
    const dm = new Map(deps.map(d => [d._id, d])), cm = new Map(chgs.map(c => [c._id, c]));
    const links = rawLinks.map(l => {
      const d = dm.get(l.deployment_id), c = cm.get(l.change_id);
      return { ...l.toJSON(), version: d && d.version, service: d && d.service, sha: c && c.sha, message: c && c.message };
    });
    res.json({ incident: i.toJSON(), updates: json(updates), links, suspects: sus });
  }));

  // ---------- timeline, dashboard, audit, stream ----------
  app.get('/api/projects/:id/timeline', h(async (req, res) => {
    const p = await projectOf(req.params.id);
    res.json(json(await M.Event.find({ project_id: p.id }).sort({ occurred_at: -1, _id: -1 }).limit(200)));
  }));

  app.get('/api/projects/:id/dashboard', h(async (req, res) => {
    const pid = (await projectOf(req.params.id)).id;
    const openQ = { project_id: pid, status: { $ne: 'resolved' } };
    const week = new Date(Date.now() - 7 * 864e5);
    const [total, openN, critical, resolved, bySev, repeated, deps, incIds] = await Promise.all([
      M.Incident.countDocuments({ project_id: pid }),
      M.Incident.countDocuments(openQ),
      M.Incident.countDocuments({ ...openQ, severity: 'critical' }),
      M.Incident.find({ project_id: pid, resolved_at: { $ne: null } }, 'started_at resolved_at').sort({ resolved_at: -1 }).limit(1000),
      M.Incident.aggregate([{ $match: openQ }, { $group: { _id: '$severity', n: { $sum: 1 } } }]),
      M.Incident.aggregate([{ $match: { project_id: pid } }, { $group: { _id: '$fingerprint', n: { $sum: 1 } } },
        { $match: { n: { $gt: 1 } } }, { $sort: { n: -1, _id: 1 } }, { $limit: 5 }]),
      M.Deployment.aggregate([{ $match: { project_id: pid, occurred_at: { $gte: week } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
      M.Incident.distinct('_id', { project_id: pid })
    ]);
    // mean time to resolve, in minutes
    const mins = resolved.map(i => (i.resolved_at - i.started_at) / 6e4);
    const mttr = mins.length ? Math.round(mins.reduce((a, b) => a + b, 0) / mins.length * 10) / 10 : null;
    // recurring failures: show the earliest title of each repeated fingerprint
    const firsts = repeated.length ? await M.Incident.find({ project_id: pid, fingerprint: { $in: repeated.map(r => r._id) } }, 'fingerprint title').sort({ _id: 1 }) : [];
    const titleOf = new Map();
    for (const i of firsts) if (!titleOf.has(i.fingerprint)) titleOf.set(i.fingerprint, i.title);
    const linked = incIds.length ? await M.IncidentLink.aggregate([
      { $match: { incident_id: { $in: incIds }, deployment_id: { $ne: null } } },
      { $group: { _id: '$deployment_id', n: { $sum: 1 } } }, { $sort: { n: -1, _id: -1 } }, { $limit: 5 }
    ]) : [];
    const depDocs = await M.Deployment.find({ _id: { $in: linked.map(l => l._id) } }, 'version service');
    const dm = new Map(depDocs.map(d => [d._id, d]));
    res.json({
      summary: { total, open: openN, critical, mttr_min: mttr },
      openBySeverity: bySev.map(r => ({ severity: r._id, n: r.n })),
      recurring: repeated.map(r => ({ title: titleOf.get(r._id) || r._id, n: r.n })),
      deploymentsLast7d: deps.map(r => ({ status: r._id, n: r.n })),
      deploymentsLinkedToIncidents: linked.filter(l => dm.has(l._id)).map(l => ({ id: l._id, version: dm.get(l._id).version, service: dm.get(l._id).service, n: l.n }))
    });
  }));

  app.get('/api/projects/:id/audit', need('admin'), h(async (req, res) => {
    const p = await projectOf(req.params.id);
    res.json(json(await M.AuditLog.find({ project_id: p.id }).sort({ _id: -1 }).limit(100)));
  }));

  app.get('/api/projects/:id/stream', h(async (req, res) => {
    const key = String((await projectOf(req.params.id)).id);
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    if (!subs.has(key)) subs.set(key, new Set());
    subs.get(key).add(res);
    const beat = setInterval(() => res.write(': ping\n\n'), 25000); // keeps proxies from closing idle streams
    req.on('close', () => {
      clearInterval(beat);
      const set = subs.get(key);
      if (set) { set.delete(res); if (!set.size) subs.delete(key); }
    });
  }));

  // ---------- GitHub webhook (push -> changes, deployment_status -> deployments); deliveries are idempotent ----------
  app.post('/api/webhooks/github/:id', h(async (req, res) => {
    const pid = (await projectOf(req.params.id)).id, sec = process.env.GITHUB_WEBHOOK_SECRET;
    if (sec) {
      const want = 'sha256=' + crypto.createHmac('sha256', sec).update(req.raw || '').digest('hex');
      const got = String(req.headers['x-hub-signature-256'] || '');
      if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) throw httpError(401, 'bad signature');
    }
    const ev = req.headers['x-github-event'], b = req.body || {};
    if (ev === 'push') {
      for (const c of b.commits || []) {
        await upsertChange(pid, {
          sha: c.id, message: c.message, author: c.author && c.author.name,
          files: [...(c.added || []), ...(c.modified || []), ...(c.removed || [])], committed_at: c.timestamp
        }, 'github');
      }
    } else if (ev === 'deployment_status') {
      const d = b.deployment, s = b.deployment_status;
      if (!d || !s) throw httpError(400, 'deployment and deployment_status required');
      const map = { success: 'succeeded', failure: 'failed', error: 'failed' };
      await upsertDeployment(pid, {
        dedupe_key: 'gh:' + d.id, version: `${d.ref}@${String(d.sha).slice(0, 7)}`, environment: d.environment,
        status: map[s.state] || 'pending', deployed_by: s.creator && s.creator.login, commit_shas: [d.sha],
        deployed_at: d.created_at, status_at: s.created_at
      }, 'github');
    }
    res.json({ ok: true });
  }));

  // ---------- static client, 404s, errors ----------
  app.use('/api', (_req, _res, next) => next(httpError(404, 'not found')));
  const dist = path.join(__dirname, '..', 'client', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    let status = err.status || 500, message = err.message || 'Server error';
    if (err.name === 'ValidationError' || err.name === 'CastError') status = 400;
    else if (isDup(err)) { status = 409; message = 'Duplicate record'; }
    else if (/ServerSelection|MongoNetwork|MongoNotConnected/.test(err.name || '')) {
      status = 503; message = 'Cannot reach the database. Check that MongoDB is running and MONGODB_URI is correct.';
    } else if (!err.status) message = 'Server error';
    if (status >= 500 && status !== 503) console.error(err);
    res.status(status).json({ error: message, ...(err.current ? { current: err.current } : {}) });
  });

  return app;
}

module.exports = { createApp, fingerprint };
