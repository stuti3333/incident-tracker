const { createApp } = require('./app');
const M = require('./models');

const uri =
  process.env.MONGODB_URI ||
  'mongodb+srv://stutizingade_db_user:tXNNEAw9JORJ1bqt@cluster0.nsju2wg.mongodb.net/incident_tracker';
const port = process.env.PORT || 3000;

async function connect() {
  for (let attempt = 1; ; attempt++) {
    try {
      await M.mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
      await Promise.all(
        Object.values(M)
          .filter((m) => m && m.init && m.modelName)
          .map((m) => m.init()),
      );
      console.log('database ready');
      return;
    } catch (e) {
      console.error(
        `Cannot use MongoDB at ${uri.replace(/\/\/[^@/]*@/, '//***@')} (attempt ${attempt}): ${e.message}`,
      );
      console.error(
        'Start MongoDB or set MONGODB_URI, e.g. mongodb://127.0.0.1:27017/incident_tracker. Retrying in 3s.\n',
      );
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

createApp().listen(port, () => console.log('listening on :' + port));
connect();
