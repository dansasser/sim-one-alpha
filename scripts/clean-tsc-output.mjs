import { rmSync } from 'node:fs';

rmSync('.tmp/tsc', { recursive: true, force: true });
