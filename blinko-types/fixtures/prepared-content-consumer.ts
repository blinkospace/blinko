import type { PluginServicesSdk } from 'blinko/services';
import SimilarContentPlugin from './similar-content-plugin';
declare const sdk: PluginServicesSdk;
const plugin = new SimilarContentPlugin(sdk);
plugin.init();
void plugin.checkPreparedNote(1).then(report => {
  if (report) {
    const preparedRange: 'prepared-subset' = report.range.kind;
    const remainder: 'yes' | 'no' | 'unknown' = report.result.retrieval.remaining;
    void [preparedRange, remainder];
  }
});
const attachment: string | null = plugin.attachmentUrl('/api/file/synthetic.png');
void attachment;
plugin.destroy();
// @ts-expect-error note ids are numeric.
void plugin.checkPreparedNote('1');
