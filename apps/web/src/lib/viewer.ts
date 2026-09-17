import { connectSignaling, type SignalingSession } from "./signaling";
import { getIceServers } from "./turn";

export type ViewingHandle = {
  stop: () => void;
};

export type ViewingStatus = "connecting" | "reconnecting" | "live" | "offline";

export function startViewing(options: {
  code: string;
  video: HTMLVideoElement;
  onStatus: (status: ViewingStatus) => void;
  onStream: (stream: MediaStream | null) => void;
  onError: (message: string) => void;
}): ViewingHandle {
  let session: SignalingSession;
  let pc: RTCPeerConnection | null = null;
  let hostId: string | null = null;
  let stopped = false;
  let pcGeneration = 0;

  const clearPc = () => {
    if (pc) {
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.close();
      pc = null;
    }
    pcGeneration += 1;
  };

  const makePc = async () => {
    clearPc();
    const generation = pcGeneration;
    const iceServers = await getIceServers(options.code);
    if (stopped || generation !== pcGeneration) {
      return;
    }
    const next = new RTCPeerConnection({ iceServers });
    next.ontrack = (event) => {
      const stream = event.streams[0] ?? null;
      options.video.srcObject = stream;
      options.video.play().catch(() => {});
      options.onStream(stream);
      options.onStatus("live");
    };
    next.onicecandidate = (event) => {
      if (event.candidate && hostId) {
        session.send({
          type: "ice-candidate",
          to: hostId,
          candidate: event.candidate.toJSON(),
        });
      }
    };
    pc = next;
  };

  session = connectSignaling(options.code, {
    async onMessage(message) {
      switch (message.type) {
        case "joined":
          hostId = message.hostId ?? null;
          if (!hostId) {
            options.onStatus("offline");
          }
          break;
        case "offer":
          hostId = message.from;
          if (!pc) {
            await makePc();
          }
          if (!pc || stopped) {
            return;
          }
          options.onStatus("connecting");
          pc.setRemoteDescription(message.sdp)
            .then(() => pc!.createAnswer())
            .then((answer) => pc!.setLocalDescription(answer))
            .then(() => {
              if (pc?.localDescription) {
                session.send({ type: "answer", to: message.from, sdp: pc.localDescription });
              }
            })
            .catch((error: unknown) => options.onError(String(error)));
          break;
        case "ice-candidate":
          if (pc && message.candidate) {
            pc.addIceCandidate(message.candidate).catch(() => {});
          }
          break;
        case "host-left":
          options.video.srcObject = null;
          options.onStream(null);
          clearPc();
          hostId = null;
          options.onStatus("offline");
          session.restart();
          break;
        case "error":
          options.onError(message.message);
          break;
      }
    },
    onOpen() {
      options.onStatus("connecting");
      session.send({ type: "join", role: "viewer" });
    },
    onClose() {
      hostId = null;
      clearPc();
      options.onStatus("reconnecting");
    },
  });

  return {
    stop() {
      stopped = true;
      clearPc();
      session.close();
      options.video.srcObject = null;
      options.onStream(null);
    },
  };
}
