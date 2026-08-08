module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  // Default (5000ms) is too tight for tests doing real async work (retry
  // loops with backoff, concurrency-pool draining, large batch writes) once
  // the machine is under load (e.g. full parallel suite + pre-push hook
  // running concurrently) -- these tests pass reliably in isolation and only
  // flake under contention. 15s gives real headroom without masking a truly
  // hung test.
  testTimeout: 15000,
};
