import { useCallback, useEffect, useRef, useState } from 'react';
import SpecularButton from '../components/SpecularButton.jsx';
import FaultyTerminal from '../components/FaultyTerminal.jsx';
import TechText from '../components/TechText.jsx';
import BranchedMenu from '../components/BranchedMenu.jsx';
import ReflectCard from './ReflectCard.jsx';
import './tracker.css';

const fmt = (t) => new Date(t).toLocaleString();
const iso = (v) => (v ? new Date(v).toISOString() : undefined);
const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const STATUSES = ['open', 'investigating', 'mitigated', 'resolved'];
const FONT = "'Bricolage Grotesque', 'Segoe UI', system-ui, sans-serif";
const MENU = [
  { label: 'Overview', value: 'dashboard' },
  {
    label: 'Report',
    children: [
      { value: 'report', label: 'Report incident' },
      { value: 'deploy', label: 'Record deployment' },
    ],
  },
  {
    label: 'Incidents',
    children: [
      { value: 'incidents', label: 'All incidents' },
      { value: 'detail', label: 'Selected incident' },
      { value: 'timeline', label: 'Timeline' },
    ],
  },
];

export default function Tracker({ onHome }) {
  const [panel, setPanel] = useState('dashboard');
  const [menuKey, setMenuKey] = useState(0);
  const [projects, setProjects] = useState([]);
  const [pid, setPid] = useState('');
  const [token, setToken] = useState('dev-token');
  const [user, setUser] = useState('stuti');
  const [msg, setMsg] = useState('');
  const [dash, setDash] = useState(null);
  const [list, setList] = useState([]);
  const [tl, setTl] = useState([]);
  const [cur, setCur] = useState(null);
  const [detail, setDetail] = useState(null);

  const [it, setIt] = useState('');
  const [is, setIs] = useState('medium');
  const [isv, setIsv] = useState('');
  const [ist, setIst] = useState('');
  const [dv, setDv] = useState('');
  const [dsv, setDsv] = useState('');
  const [dst, setDst] = useState('succeeded');
  const [dt, setDt] = useState('');
  const [showNewProject, setShowNewProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');

  const auth = useRef({ token, user });
  auth.current = { token, user };

  const api = useCallback(async (path, opts = {}) => {
    let r;
    try {
      r = await fetch('/api' + path, {
        ...opts,
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + auth.current.token,
          'X-User': auth.current.user || 'anon',
        },
        body: opts.body && JSON.stringify(opts.body),
      });
    } catch {
      const e = new Error('Cannot reach the server. Is the API running?');
      setMsg(e.message);
      throw e;
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setMsg(j.error || r.statusText);
      const e = new Error(j.error);
      e.res = j;
      throw e;
    }
    setMsg('');
    return j;
  }, []);

  const loadProjects = useCallback(
    async (select) => {
      const ps = await api('/projects');
      setProjects(ps);
      setPid((prev) => {
        if (select != null) return String(select);
        if (prev && ps.some((p) => String(p.id) === prev)) return prev;
        return ps.length ? String(ps[0].id) : '';
      });
    },
    [api],
  );

  const loadDetail = useCallback(
    async (id) => {
      setDetail(await api('/incidents/' + id));
    },
    [api],
  );

  const curRef = useRef(null);
  curRef.current = cur;

  const load = useCallback(async () => {
    if (!pid) return;
    const [d, l, t] = await Promise.all([
      api(`/projects/${pid}/dashboard`),
      api(`/projects/${pid}/incidents`),
      api(`/projects/${pid}/timeline`),
    ]);
    setDash(d);
    setList(l);
    setTl(t);
    if (curRef.current) loadDetail(curRef.current).catch(() => {});
  }, [api, pid, loadDetail]);

  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    loadProjects().catch(() => {});
  }, [loadProjects, token]);

  useEffect(() => {
    load().catch(() => {});
  }, [load, token]);

  useEffect(() => {
    if (!pid) return undefined;
    const es = new EventSource(`/api/projects/${pid}/stream?token=${token}`);
    ['deployment', 'change', 'incident'].forEach((t) =>
      es.addEventListener(t, () => loadRef.current().catch(() => {})),
    );
    return () => es.close();
  }, [pid, token]);

  const pickProject = (id) => {
    setPid(id);
    setCur(null);
    setDetail(null);
  };
  const goto = (v) => {
    setPanel(v);
    setMenuKey((k) => k + 1);
  };
  const open = (id) => {
    setCur(id);
    loadDetail(id).catch(() => {});
    goto('detail');
  };

  const newProject = async () => {
    setShowNewProject(true);
  };

  const createProject = async () => {
    if (!newProjectName.trim()) return;
    try {
      await api('/projects', {
        method: 'POST',
        body: { name: newProjectName.trim() },
      });
      setNewProjectName('');
      setShowNewProject(false);
      loadProjects();
    } catch {}
  };

  const report = async () => {
    if (!pid) return setMsg('Create a project first (New project).');
    if (!it.trim()) return setMsg('Describe what is failing first.');
    try {
      const r = await api(`/projects/${pid}/incidents`, {
        method: 'POST',
        body: { title: it, severity: is, service: isv, started_at: iso(ist) },
      });
      setIt('');
      if (r.duplicate)
        setMsg('Already tracked: merged into the open incident.');
      load();
    } catch {}
  };

  const record = async () => {
    if (!pid) return setMsg('Create a project first (New project).');
    if (!dv.trim()) return setMsg('A version is required.');
    try {
      await api(`/projects/${pid}/deployments`, {
        method: 'POST',
        body: { version: dv, service: dsv, status: dst, deployed_at: iso(dt) },
      });
      setDv('');
      load();
    } catch {}
  };

  const s = dash?.summary;

  const titles = {
    dashboard: 'Dashboard',
    timeline: 'Timeline',
    report: 'Report incident',
    deploy: 'Record deployment',
    incidents: 'Incidents',
    detail: detail ? `Incident #${detail.incident.id}` : 'Select an incident',
  };

  const panels = {
    dashboard: s ? (
      <>
        <div className="stats">
          <div>
            <b>{s.open}</b>
            <span>open</span>
          </div>
          <div>
            <b>{s.critical}</b>
            <span>critical</span>
          </div>
          <div>
            <b>{s.total}</b>
            <span>total</span>
          </div>
          <div>
            <b>{s.mttr_min ?? '–'}</b>
            <span>MTTR min</span>
          </div>
        </div>
        <p className="mut">
          Deploys, 7 days:{' '}
          {dash.deploymentsLast7d.map((x) => x.n + ' ' + x.status).join(', ') ||
            'none'}
        </p>
        <p>
          <b>Recurring:</b>{' '}
          {dash.recurring.length ? (
            dash.recurring.map((r) => `${r.title} (×${r.n})`).join('; ')
          ) : (
            <span className="mut">none yet</span>
          )}
        </p>
        <p>
          <b>Most-implicated deploys:</b>{' '}
          {dash.deploymentsLinkedToIncidents.length ? (
            dash.deploymentsLinkedToIncidents
              .map((r) => `${r.version} (${r.n})`)
              .join('; ')
          ) : (
            <span className="mut">none linked</span>
          )}
        </p>
      </>
    ) : (
      <p className="mut">
        {pid
          ? 'Loading…'
          : projects.length
            ? 'Pick a project.'
            : 'No project yet. Use “New project” in the top bar to create one.'}
      </p>
    ),
    report: (
      <>
        <input
          placeholder="What is failing?"
          style={{ width: '100%' }}
          value={it}
          onChange={(e) => setIt(e.target.value)}
        />
        <div className="row">
          <select value={is} onChange={(e) => setIs(e.target.value)}>
            {SEVERITIES.map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
          <input
            placeholder="Service"
            value={isv}
            onChange={(e) => setIsv(e.target.value)}
          />
        </div>
        <div className="row">
          <input
            type="datetime-local"
            title="When it started (leave empty for now)"
            value={ist}
            onChange={(e) => setIst(e.target.value)}
          />
        </div>
        <div className="cta">
          <SpecularButton size="md" radius={14} onClick={report}>
            Report
          </SpecularButton>
        </div>
      </>
    ),
    deploy: (
      <>
        <div className="row">
          <input
            placeholder="Version"
            value={dv}
            onChange={(e) => setDv(e.target.value)}
          />
          <input
            placeholder="Service"
            value={dsv}
            onChange={(e) => setDsv(e.target.value)}
          />
        </div>
        <div className="row">
          <select value={dst} onChange={(e) => setDst(e.target.value)}>
            {['succeeded', 'failed', 'rolled_back', 'pending'].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
          <input
            type="datetime-local"
            title="Leave empty if unknown"
            value={dt}
            onChange={(e) => setDt(e.target.value)}
          />
        </div>
        <div className="cta">
          <SpecularButton size="md" radius={14} onClick={record}>
            Record deployment
          </SpecularButton>
        </div>
      </>
    ),
    incidents: list.length ? (
      list.map((i) => (
        <div
          key={i.id}
          className={`inc ${i.severity}`}
          tabIndex={0}
          role="button"
          onClick={() => open(i.id)}
          onKeyDown={(e) =>
            (e.key === 'Enter' || e.key === ' ') &&
            (e.preventDefault(), open(i.id))
          }
        >
          <b>
            #{i.id} {i.title}
          </b>
          <br />
          <span className="tag">{i.severity}</span>{' '}
          <span className="tag">{i.status}</span>{' '}
          <span className="mut">
            {i.service || ''} {i.assignee ? '→ ' + i.assignee : ''}{' '}
            {i.report_count > 1 ? '· ' + i.report_count + ' reports' : ''}
          </span>
        </div>
      ))
    ) : (
      <p className="mut">No incidents. Report one from the menu.</p>
    ),
    detail: detail ? (
      <IncidentDetail
        key={`${detail.incident.id}:${detail.incident.version}`}
        data={detail}
        api={api}
        setMsg={setMsg}
        reload={() => loadDetail(detail.incident.id)}
        reloadAll={load}
      />
    ) : (
      <p className="mut">
        Pick one from All incidents to see suspect deployments, updates, and
        edit status.
      </p>
    ),
    timeline: tl.length ? (
      tl.map((e) => (
        <div
          className="tl"
          key={e.id ?? `${e.kind}:${e.ref_id}:${e.occurred_at}`}
        >
          <time>
            {fmt(e.occurred_at)}
            {new Date(e.received_at) - new Date(e.occurred_at) > 6e4
              ? ' (logged late)'
              : ''}
          </time>
          <br />
          {e.title}
        </div>
      ))
    ) : (
      <p className="mut">No events yet.</p>
    ),
  };

  return (
    <div className="tk">
      <div className="tk__bg" aria-hidden="true">
        <FaultyTerminal
          tint="#ff6a3d"
          glyphs="blocks"
          scale={1.5}
          digitSize={1.2}
          timeScale={0.4}
          brightness={0.5}
          glow={0.5}
          persistence={0.5}
          mouseStrength={0.5}
          mouseGlow={0.5}
          curvature={0.1}
          vignette={0.5}
          clickEffect="none"
        />
      </div>
      <header>
        <a
          className="tk__back"
          href="#/"
          onClick={(e) => {
            e.preventDefault();
            onHome?.();
          }}
        >
          ← Home
        </a>
        <select
          aria-label="Project"
          value={pid}
          onChange={(e) => pickProject(e.target.value)}
        >
          {projects.map((p) => (
            <option key={p._id} value={p._id}>
              {p.name}
            </option>
          ))}
        </select>
        <SpecularButton size="sm" radius={12} onClick={newProject}>
          New project
        </SpecularButton>
        {showNewProject && (
          <div
            className="modal-overlay"
            onClick={() => setShowNewProject(false)}
          >
            <ReflectCard title="Create New Project">
              <input
                type="text"
                placeholder="Project name"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createProject()}
                autoFocus
              />
              <div className="modal-actions">
                <SpecularButton
                  size="sm"
                  radius={10}
                  onClick={() => setShowNewProject(false)}
                >
                  Cancel
                </SpecularButton>
                <SpecularButton size="sm" radius={10} onClick={createProject}>
                  Create
                </SpecularButton>
              </div>
            </ReflectCard>
          </div>
        )}
        <select
          aria-label="Role"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        >
          <option value="admin-token">admin</option>
          <option value="dev-token">developer</option>
          <option value="view-token">viewer</option>
        </select>
        <input
          aria-label="Your name"
          placeholder="Your name"
          value={user}
          onChange={(e) => setUser(e.target.value)}
          style={{ maxWidth: 130 }}
        />
        <span className="msg" role="status">
          {msg}
        </span>
      </header>
      <main>
        <aside>
          <div className="tk__word" aria-hidden="true">
            <TechText
              text="Tracker"
              align="left"
              fontFamily={FONT}
              fontWeight={700}
              fontSize={120}
              reveal="letter"
              intro="metrics"
              introDuration={2}
              guides
              specks={12}
              clickKick
            />
          </div>
          <h1 className="sr-only">Incident Tracker</h1>
          <BranchedMenu
            key={menuKey}
            items={MENU}
            defaultOpen={[1, 2]}
            defaultActive={panel}
            onSelect={(v) => setPanel(v)}
            color="#ffffff"
            accentColor="#ff6a3d"
            lineColor="#1a1a2e"
            width={280}
            rowHeight={38}
            fontSize={15}
          />
        </aside>
        <div className="tk__stage">
          <ReflectCard key={panel} title={titles[panel]}>
            {panels[panel]}
          </ReflectCard>
        </div>
      </main>
    </div>
  );
}

function IncidentDetail({ data, api, setMsg, reload, reloadAll }) {
  const i = data.incident;
  const [status, setStatus] = useState(i.status);
  const [severity, setSeverity] = useState(i.severity);
  const [assignee, setAssignee] = useState(i.assignee || '');
  const [resolution, setResolution] = useState(i.resolution || '');
  const [comment, setComment] = useState('');

  const save = async () => {
    try {
      await api('/incidents/' + i.id, {
        method: 'PATCH',
        body: {
          version: i.version,
          status,
          severity,
          assignee: assignee || null,
          resolution: resolution || null,
        },
      });
      reloadAll();
    } catch (e) {
      if (e.res?.current) {
        await reload().catch(() => {});
        setMsg(
          'Someone else edited this incident. Showing the latest version.',
        );
      }
    }
  };
  const post = async () => {
    if (!comment) return;
    try {
      await api(`/incidents/${i.id}/updates`, {
        method: 'POST',
        body: { body: comment },
      });
      setComment('');
      reload();
    } catch {}
  };
  const link = async (id) => {
    try {
      await api(`/incidents/${i.id}/links`, {
        method: 'POST',
        body: { deployment_id: id },
      });
      reload();
    } catch {}
  };

  return (
    <>
      <p>
        <b>{i.title}</b>
      </p>
      <p className="mut">
        Started {fmt(i.started_at)} · reported {fmt(i.reported_at)} · v
        {i.version}
      </p>
      <div className="row">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUSES.map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
        <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
          {SEVERITIES.map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
        <input
          placeholder="Assignee"
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
        />
      </div>
      <textarea
        placeholder="Resolution details"
        rows={2}
        style={{ width: '100%' }}
        value={resolution}
        onChange={(e) => setResolution(e.target.value)}
      />
      <div className="cta">
        <SpecularButton size="sm" radius={12} onClick={save}>
          Save changes
        </SpecularButton>
      </div>

      <h2 style={{ marginTop: 14 }}>Suspect deployments</h2>
      {data.suspects.length ? (
        data.suspects.map((s) => (
          <div className="sus" key={s.deployment.id}>
            <span className="score">{s.score}</span>
            <div style={{ flex: 1 }}>
              <b>{s.deployment.version}</b>{' '}
              <span className="mut">
                {s.deployment.service || ''} · {s.deployment.status}
              </span>
              <br />
              <span className="mut">{s.reasons.join(' · ')}</span>
            </div>
            <button onClick={() => link(s.deployment.id)}>Link</button>
          </div>
        ))
      ) : (
        <p className="mut">No deployments in the 48 hours before onset.</p>
      )}
      <p>
        <b>Linked:</b>{' '}
        {data.links.length ? (
          data.links.map((l) => l.version || l.sha?.slice(0, 7)).join(', ')
        ) : (
          <span className="mut">none</span>
        )}
      </p>

      <h2>Updates</h2>
      {data.updates.map((u) => (
        <p key={u.id ?? u.created_at}>
          <b>{u.author}</b> <span className="mut">{fmt(u.created_at)}</span>
          <br />
          {u.body}
        </p>
      ))}
      <div className="row">
        <input
          placeholder="Add an update"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && post()}
        />
        <SpecularButton size="sm" radius={12} onClick={post}>
          Post
        </SpecularButton>
      </div>
    </>
  );
}
