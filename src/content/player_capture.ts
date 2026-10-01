const playerCaptureStreams = new WeakMap<HTMLVideoElement, MediaStream>();

export function getVideoStream(video: HTMLVideoElement, onDetached: (video: HTMLVideoElement) => void): MediaStream | null {
  const source = video as HTMLVideoElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream };
  let stream = playerCaptureStreams.get(video);
  if (!stream) {
    stream = source.captureStream?.() ?? source.mozCaptureStream?.();
    if (!stream) return null;
    const captured = stream;
    let released = false;
    // Chrome retains native captures on the player. Reuse one disabled audio source;
    // only per-recording clones output audio, and no original video is needed.
    const prepareTrack = (track: MediaStreamTrack) => {
      if (!captured.getTracks().includes(track)) return;
      if (released || track.kind === "video") {
        track.stop();
        captured.removeTrack(track);
      } else {
        track.enabled = false;
        for (const previous of captured.getAudioTracks()) {
          if (previous !== track) {
            previous.stop();
            captured.removeTrack(previous);
          }
        }
      }
    };
    captured.getTracks().forEach(prepareTrack);
    captured.addEventListener("addtrack", (event) => prepareTrack(event.track));
    playerCaptureStreams.set(video, captured);
    let parents: Node[] = [];
    let detachTimer = 0;
    const watchParents = () => {
      const next: Node[] = [];
      for (let parent = video.parentNode; parent; parent = parent.parentNode) next.push(parent);
      if (next.length === parents.length && next.every((parent, index) => parent === parents[index])) return;
      detachObserver.disconnect();
      next.forEach(parent => detachObserver.observe(parent, { childList: true }));
      parents = next;
    };
    const checkAttachment = () => {
      if (video.isConnected) {
        window.clearTimeout(detachTimer);
        detachTimer = 0;
        watchParents();
        return;
      }
      // SPA layouts may detach the playing element before mounting the mini player.
      // Allow one second for reattachment, then release a genuinely removed player.
      if (!detachTimer) {
        detachTimer = window.setTimeout(checkAttachment, 1000);
        return;
      }
      released = true;
      detachObserver.disconnect();
      parents = [];
      playerCaptureStreams.delete(video);
      onDetached(video);
      captured.getTracks().forEach(prepareTrack);
    };
    const detachObserver = new MutationObserver(() => {
      if (video.isConnected || !detachTimer) checkAttachment();
    });
    watchParents();
  }
  return new MediaStream(stream.getAudioTracks().filter(track => track.readyState === "live").map(track => {
    const clone = track.clone();
    clone.enabled = true;
    return clone;
  }));
}
