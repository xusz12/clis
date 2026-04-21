import { createBloombergUserCliConfig, loadOpencliRegistry } from './utils.js';

const { cli, Strategy } = await loadOpencliRegistry();

cli(createBloombergUserCliConfig({
  cli,
  Strategy,
  name: 'economics',
  description: 'Bloomberg Economics top stories via RSS with Asia/Shanghai time',
}));
