// A Controller-process lifetime marker. Durable runs from any older process
// must not reattach a socket to a client ID whose prior close may be pending.
import {randomUUID} from 'node:crypto';
export const MONITOR_INSTANCE_ID=randomUUID();
