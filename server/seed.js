// Demo data: the "who broke the build" story. Safe to run twice (it skips if the project exists).   npm run seed
const M = require('./models');
const { createApp } = require('./app');

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/incident_tracker';
const hoursAgo = h => new Date(Date.now() - h * 36e5).toISOString();

(async () => {
  await M.mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  await Promise.all(Object.values(M).filter(m => m && m.init && m.modelName).map(m => m.init()));
  if (await M.Project.exists({ name: 'Storefront' })) { console.log('Storefront already seeded'); return M.mongoose.disconnect(); }

  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, path, body, user = 'seed') => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer admin-token', 'X-User': user }, body: body && JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(`${method} ${path}: ${j.error}`);
    return j;
  };

  const p = await call('POST', '/projects', { name: 'Storefront', repo_url: 'https://github.com/example/storefront' });
  const d = path => `/projects/${p.id}/${path}`;
  await call('POST', d('changes'), { sha: 'a1b2c3d4e5f6a7b8', message: 'Add retry to payment client', author: 'asha', files: ['payments/client.js'], committed_at: hoursAgo(30) });
  await call('POST', d('changes'), { sha: 'ffee00112233aabb', message: 'Bump db pool size to 5', author: 'ravi', files: ['config/db.js'], committed_at: hoursAgo(9) });
  await call('POST', d('deployments'), { version: 'v3.1.0', service: 'checkout', status: 'succeeded', deployed_at: hoursAgo(28), deployed_by: 'asha' });
  const bad = await call('POST', d('deployments'), { version: 'v3.2.0', service: 'checkout', status: 'succeeded', deployed_at: hoursAgo(7), deployed_by: 'ravi', commit_shas: ['ffee00112233aabb'] });
  await call('POST', d('deployments'), { version: 'v3.2.1', service: 'search', status: 'succeeded', deployed_at: hoursAgo(5) });
  // a deployment record that arrived with no time at all (shown as "estimated")
  await call('POST', d('deployments'), { version: 'v3.2.2', service: 'checkout', status: 'rolled_back' });
  const inc = await call('POST', d('incidents'), { title: 'Checkout returns 500 for card payments', severity: 'critical', service: 'checkout', started_at: hoursAgo(6.5) }, 'maya');
  await call('POST', d('incidents'), { title: 'Checkout returns 500 for card payments', severity: 'critical', service: 'checkout' }, 'li'); // duplicate report -> folded
  await call('POST', `/incidents/${inc.id}/updates`, { body: 'Errors started right after the 3.2.0 deploy. DB connections are exhausted.' }, 'maya');
  await call('POST', `/incidents/${inc.id}/links`, { deployment_id: bad.id }, 'maya');
  await call('PATCH', `/incidents/${inc.id}`, { version: inc.version, status: 'investigating', assignee: 'ravi' }, 'maya');
  const old = await call('POST', d('incidents'), { title: 'Search results empty for long queries', severity: 'medium', service: 'search', started_at: hoursAgo(50) });
  await call('PATCH', `/incidents/${old.id}`, { version: old.version, status: 'resolved', resolution: 'Raised the query length limit.' });
  console.log(`seeded project "Storefront" (id ${p.id})`);
  server.close();
  await M.mongoose.disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
