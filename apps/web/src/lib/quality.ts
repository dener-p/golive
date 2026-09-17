export type StreamQuality = "low" | "medium" | "high";

export type StreamQualityPreset = {
  label: string;
  description: string;
  width: number;
  height: number;
  maxFramerate: number;
};

export const STREAM_QUALITIES: Record<StreamQuality, StreamQualityPreset> = {
  low: {
    label: "Low",
    description: "720p · 30fps",
    width: 1280,
    height: 720,
    maxFramerate: 30,
  },
  medium: {
    label: "Medium",
    description: "1080p · 30fps",
    width: 1920,
    height: 1080,
    maxFramerate: 30,
  },
  high: {
    label: "High",
    description: "1080p · 60fps",
    width: 1920,
    height: 1080,
    maxFramerate: 60,
  },
};

export const STREAM_QUALITY_ORDER: StreamQuality[] = ["low", "medium", "high"];