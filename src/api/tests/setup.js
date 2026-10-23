/* eslint-disable no-console */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

/**
 * Test environment, loaded before the test files (mocha --file).
 * Without MONGO_URI_TESTS the run gets a throw-away local mongod; every other
 * variable of .env.example that is not set falls back to the example value, or
 * to a placeholder where the example leaves it empty (dotenv-safe rejects empty
 * values).
 */
const PLACEHOLDERS = {
  EMAIL_HOST: '127.0.0.1',
  EMAIL_PORT: '2525',
  EMAIL_USERNAME: 'test',
  EMAIL_PASSWORD: 'test',
};

let mongod;
let dbPath;
let mongoPort;

if (!process.env.MONGO_URI_TESTS) {
  mongoPort = 27100 + (process.pid % 800);
  const port = mongoPort;
  dbPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mongod-tests-'));
  mongod = spawn('mongod', ['--dbpath', dbPath, '--port', String(port), '--bind_ip', '127.0.0.1', '--quiet'], {
    stdio: 'ignore',
  });
  mongod.on('error', (err) => console.error(`could not start mongod for the tests: ${err.message}`));
  process.env.MONGO_URI_TESTS = `mongodb://127.0.0.1:${port}/express-rest-boilerplate-tests`;
}

const example = fs.readFileSync(path.join(__dirname, '../../../.env.example'), 'utf8');
example.split('\n').forEach((line) => {
  const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (match && !process.env[match[1]]) {
    process.env[match[1]] = match[2] || PLACEHOLDERS[match[1]] || 'test';
  }
});

const accepting = (port) => new Promise((resolve) => {
  const socket = net.connect(port, '127.0.0.1');
  socket.once('connect', () => {
    socket.end();
    resolve(true);
  });
  socket.once('error', () => resolve(false));
});

// the tests start once the local mongod accepts connections and the unique
// indexes the duplicate-email checks rely on exist in the fresh database
before(async function waitForDatabase() {
  this.timeout(60000);
  if (mongod) {
    let ready = false;
    for (let attempt = 0; attempt < 240 && !ready; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      ready = await accepting(mongoPort);
      // eslint-disable-next-line no-await-in-loop
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error('mongod did not start for the tests');
  }
  await require('../models/user.model').init(); // eslint-disable-line global-require
});

after(() => {
  if (!mongod) return;
  mongod.kill();
  fs.rmSync(dbPath, { recursive: true, force: true });
});
