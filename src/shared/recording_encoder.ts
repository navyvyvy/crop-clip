// Classic script shared by the content script and result page.
// Chrome queues video frames until GPU encoder discovery finishes, but can drop
// that queue on an early MediaRecorder.stop(). Query support before recording;
// this does not create an encoder or change the chosen recording codec.
async function prepareRecordingEncoder(): Promise<void> {
  if (typeof VideoEncoder === "undefined") return;
  let timeoutId = 0;
  try {
    await Promise.race([
      VideoEncoder.isConfigSupported({
        codec: "avc1.42001e",
        width: 640,
        height: 360,
        hardwareAcceleration: "prefer-hardware",
      }),
      new Promise<never>((_resolve, reject) => {
        timeoutId = window.setTimeout(() => reject(new Error("녹화 준비가 지연되고 있습니다. 잠시 후 다시 시도하세요.")), 15_000);
      }),
    ]);
  } finally {
    window.clearTimeout(timeoutId);
  }
}
