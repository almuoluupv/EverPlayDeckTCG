import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { assertEnv } from './server.js';

test('ADMIN_EMAIL vacío es válido y uno mal formado no incluye claves', () => {
  const cfg = assertEnv({
    CLERK_PUBLISHABLE_KEY: 'pk_test_local',
    CLERK_SECRET_KEY: 'sk_test_local',
    MONGODB_URI: 'mongodb://localhost/album',
    PAGES_ORIGIN: 'https://almuoluupv.github.io',
    ADMIN_EMAIL: '  Persona@Example.com ',
  });
  assert.equal(cfg.adminEmail, 'persona@example.com');
  assert.throws(
    () => assertEnv({
      CLERK_PUBLISHABLE_KEY: 'pk_test_local',
      CLERK_SECRET_KEY: 'sk_test_local',
      MONGODB_URI: 'mongodb://localhost/album',
      PAGES_ORIGIN: 'https://almuoluupv.github.io',
      ADMIN_EMAIL: 'no-es-correo',
    }),
    (err) => {
      assert.match(err.message, /ADMIN_EMAIL/);
      assert.equal(err.message.includes('sk_test_local'), false);
      return true;
    },
  );
});

test('assertEnv exige las cuatro variables y no devuelve la clave secreta en el mensaje', () => {
  assert.throws(
    () => assertEnv({ CLERK_PUBLISHABLE_KEY: 'pk_test_x', CLERK_SECRET_KEY: '', MONGODB_URI: '', PAGES_ORIGIN: '' }),
    (err) => {
      assert.match(err.message, /CLERK_SECRET_KEY/);
      assert.match(err.message, /MONGODB_URI/);
      assert.match(err.message, /PAGES_ORIGIN/);
      assert.equal(err.message.includes('sk_'), false);
      return true;
    },
  );
});

test('el proceso de la API sale si faltan Mongo o el origen', async () => {
  const child = spawn(process.execPath, ['api/server.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CLERK_PUBLISHABLE_KEY: 'pk_test_local',
      CLERK_SECRET_KEY: 'sk_test_local',
    },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 1);
  assert.match(stderr, /MONGODB_URI/);
  assert.match(stderr, /PAGES_ORIGIN/);
  assert.equal(stderr.includes('sk_test_local'), false);
});
