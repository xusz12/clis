import { createBloombergUserCliConfig, loadOpencliRegistry } from './utils.js';

const { cli, Strategy } = await loadOpencliRegistry();

cli(createBloombergUserCliConfig({
  cli,
  Strategy,
  name: 'tech',
  description: 'Bloomberg Tech top stories via RSS with Asia/Shanghai time',
}));
