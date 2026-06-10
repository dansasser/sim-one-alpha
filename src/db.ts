import { loadGoromboConfig } from './config/gorombo-config.js';
import { createGoromboPersistenceRuntime } from './session/session-persistence.js';

export const goromboPersistenceRuntime = createGoromboPersistenceRuntime(loadGoromboConfig());

export default goromboPersistenceRuntime.adapter;
