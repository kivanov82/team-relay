// The stdio suites drive the bundled servers (node dist/*.js), so build them first.
import { build } from '../../scripts/build.js';

export default async function setup(): Promise<void> {
  await build();
}
