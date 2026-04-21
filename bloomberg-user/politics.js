import { createBloombergUserCliConfig, loadOpencliRegistry } from './utils.js';

const { cli, Strategy } = await loadOpencliRegistry();

cli(createBloombergUserCliConfig({
  cli,
  Strategy,
  name: 'politics',
  description: 'Bloomberg Politics top stories via RSS with Asia/Shanghai time',
}));
