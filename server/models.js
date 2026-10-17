// MongoDB models (Mongoose).
//
// Every collection uses a small sequential integer as _id (see nextId) instead of an ObjectId.
// Incident numbers like "#12" are what people say out loud during an outage, and the React client
// displays them directly. Relations are plain integer references, so no populate() is needed.
const mongoose = require('mongoose');
const { Schema } = mongoose;

const Counter = mongoose.model('Counter', new Schema({ _id: String, seq: { type: Number, default: 0 } }, { versionKey: false }));
// Two first-ever callers can race to create the same counter document; the loser gets a duplicate-key error and retries.
const nextId = async name => {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await Counter.findByIdAndUpdate(name, { $inc: { seq: 1 } }, { new: true, upsert: true })).seq;
    } catch (e) {
      if (!(e && (e.code === 11000 || e.code === 11001)) || attempt >= 5) throw e;
    }
  }
};

// JSON shape the client expects: `_id` is exposed as `id`, internals are hidden.
const toJSON = {
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
    delete ret.open_key;
    delete ret.rev;
    return ret;
  }
};
const make = (name, fields, indexes = []) => {
  // `id: false` drops Mongoose's default string `id` virtual (aggregation $match does not cast, so it must stay numeric)
  const s = new Schema({ _id: Number, ...fields }, { versionKey: false, id: false, toJSON });
  s.virtual('id').get(function () { return this._id; });
  indexes.forEach(([spec, opts]) => s.index(spec, opts));
  return mongoose.model(name, s);
};

const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const STATUSES = ['open', 'investigating', 'mitigated', 'resolved'];
const DEPLOY_STATUSES = ['pending', 'succeeded', 'failed', 'rolled_back'];

const Project = make('Project', {
  name: { type: String, required: true, trim: true, unique: true },
  repo_url: String,
  created_at: { type: Date, default: Date.now }
});

const Deployment = make('Deployment', {
  project_id: { type: Number, required: true },
  dedupe_key: { type: String, required: true },
  version: { type: String, required: true },
  service: String,
  environment: { type: String, default: 'production' },
  status: { type: String, enum: DEPLOY_STATUSES, default: 'succeeded' },
  status_at: { type: Date, default: Date.now },   // when the status was observed (orders conflicting updates)
  deployed_by: String,
  commit_shas: { type: [String], default: [] },
  occurred_at: { type: Date, required: true },
  time_estimated: { type: Boolean, default: false }, // true if the record arrived without a deploy time
  received_at: { type: Date, default: Date.now },
  rev: { type: Number, default: 0 }                  // internal counter for compare-and-set merges
}, [[{ project_id: 1, dedupe_key: 1 }, { unique: true }], [{ project_id: 1, occurred_at: -1 }]]);

const Change = make('Change', {
  project_id: { type: Number, required: true },
  sha: { type: String, required: true },
  message: String,
  author: String,
  files: { type: [String], default: [] },
  committed_at: { type: Date, default: Date.now },
  received_at: { type: Date, default: Date.now }
}, [[{ project_id: 1, sha: 1 }, { unique: true }], [{ project_id: 1, committed_at: -1 }]]);

const Incident = make('Incident', {
  project_id: { type: Number, required: true },
  title: { type: String, required: true, trim: true },
  fingerprint: { type: String, required: true },
  // "<project>:<fingerprint>" while the incident is unresolved, removed on resolve. A sparse unique index on it
  // guarantees two simultaneous reports of the same failure cannot create two open incidents.
  open_key: String,
  service: String,
  severity: { type: String, enum: SEVERITIES, default: 'medium' },
  status: { type: String, enum: STATUSES, default: 'open' },
  assignee: String,
  resolution: String,
  started_at: { type: Date, required: true },        // when it actually began (may precede the report)
  reported_at: { type: Date, default: Date.now },
  resolved_at: Date,
  report_count: { type: Number, default: 1 },
  version: { type: Number, default: 1 },             // optimistic concurrency token
  created_by: String,
  updated_at: { type: Date, default: Date.now }
}, [
  [{ project_id: 1, fingerprint: 1 }],
  [{ open_key: 1 }, { unique: true, sparse: true }]
]);

// Append-only: concurrent contributors never overwrite each other.
const IncidentUpdate = make('IncidentUpdate', {
  incident_id: { type: Number, required: true, index: true },
  author: { type: String, required: true },
  body: { type: String, required: true },
  created_at: { type: Date, default: Date.now }
});

const IncidentLink = make('IncidentLink', {
  incident_id: { type: Number, required: true },
  deployment_id: { type: Number, default: null },
  change_id: { type: Number, default: null },
  note: String,
  linked_by: String
}, [[{ incident_id: 1, deployment_id: 1, change_id: 1 }, { unique: true }]]);

// Per-project timeline, ordered by occurred_at rather than arrival order.
const Event = make('Event', {
  project_id: { type: Number, required: true },
  kind: { type: String, required: true },
  ref_id: Number,
  title: { type: String, required: true },
  actor: String,
  occurred_at: { type: Date, required: true },
  received_at: { type: Date, default: Date.now },
  dedupe_key: { type: String, required: true }
}, [[{ project_id: 1, dedupe_key: 1 }, { unique: true }], [{ project_id: 1, occurred_at: -1 }]]);

const AuditLog = make('AuditLog', {
  project_id: Number,
  actor: String,
  action: { type: String, required: true },
  entity: String,
  entity_id: Number,
  detail: Schema.Types.Mixed,
  at: { type: Date, default: Date.now }
}, [[{ project_id: 1, at: -1 }]]);

module.exports = {
  mongoose, nextId, SEVERITIES, STATUSES, DEPLOY_STATUSES,
  Project, Deployment, Change, Incident, IncidentUpdate, IncidentLink, Event, AuditLog
};
