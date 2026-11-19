import './styles.css';
import { App } from './core/App.ts';
import { Stage } from './render/Stage.ts';
import { FaceTracker, HandTracker, PoseTracker } from './tracking/MediaPipeTrackers.ts';
import { TrackerHost } from './tracking/TrackerHost.ts';
import { Panel, toast } from './ui/Panel.ts';
import { AvatarPlugin } from './plugins/AvatarPlugin.ts';
import { CapturePlugin } from './plugins/CapturePlugin.ts';
import { DiagnosticsPlugin } from './plugins/DiagnosticsPlugin.ts';
import { DesignerPlugin } from './plugins/DesignerPlugin.ts';
import { HairPlugin } from './plugins/HairPlugin.ts';
import { LiveDirectorPlugin } from './plugins/LiveDirectorPlugin.ts';
import { ModelsPlugin } from './plugins/ModelsPlugin.ts';
import { ReactorPlugin } from './plugins/ReactorPlugin.ts';
import { SpatialPlugin } from './plugins/SpatialPlugin.ts';
import { BackgroundPlugin, OverlayPlugin, VoicePlugin } from './plugins/StagePlugins.ts';

/**
 * Composition root. The real-time loop (camera -> MediaPipe -> coordinates -> solver ->
 * smoothing -> avatar) lives in App; every other capability is a plugin registered here.
 * To add a feature, implement `Plugin` and `app.use()` it.
 */
async function main() {
  const stage = new Stage(document.getElementById('stage')!);
  // Order matters: pose first — the face tracker crops small heads using pose landmarks and the
  // hand tracker matches hand sides to pose wrists.
  const trackers = new TrackerHost().add(new PoseTracker()).add(new FaceTracker()).add(new HandTracker());
  const app = new App(stage, trackers, new Panel(document.getElementById('panel')!));
  (window as unknown as { vtuber: App }).vtuber = app; // handy for debugging in DevTools

  await app.use(new OverlayPlugin());
  app.start();

  app.bus.emit('status', { key: 'init', text: 'MediaPipe を初期化中…' });
  const trackersReady = trackers
    .init((msg) => app.bus.emit('status', { key: 'init', text: msg }))
    .then(() => app.bus.emit('status', { key: 'init', text: '' }))
    .catch((err) => {
      app.bus.emit('status', { key: 'init', text: '' });
      toast(`トラッカーを初期化できません: ${err.message}`, 'error', 10000);
    });

  await app.use(new AvatarPlugin());
  await trackersReady;
  await app.use(new CapturePlugin());
  await app.use(new HairPlugin());
  await app.use(new ModelsPlugin());
  await app.use(new DesignerPlugin());
  await app.use(new LiveDirectorPlugin());
  await app.use(new ReactorPlugin());
  await app.use(new SpatialPlugin());
  await app.use(new BackgroundPlugin());
  await app.use(new VoicePlugin());
  await app.use(new DiagnosticsPlugin());

  if (new URLSearchParams(location.search).has('autostart')) {
    document.querySelector<HTMLButtonElement>('#panel .btn.primary')?.click();
  }
}

main().catch((err) => {
  console.error(err);
  toast(`起動に失敗しました: ${err.message}`, 'error', 15000);
});
