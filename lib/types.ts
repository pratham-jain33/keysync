// Shared music types for KeySync.

export interface NoteEvent {
  /** seconds from song start */
  start: number;
  /** seconds from song start */
  end: number;
  /** MIDI note number, e.g. 60 = middle C */
  midi: number;
  /** 0..1, optional */
  velocity?: number;
  hand?: "left" | "right";
}

export interface ChordEvent {
  /** seconds from song start */
  start: number;
  /** seconds from song start */
  end: number;
  /** pitch class of the chord root, 0 = C .. 11 = B */
  root: number;
  /** e.g. "C", "Am", "G7" */
  name: string;
  /** pitch classes in the chord, e.g. [0, 4, 7] */
  tones: number[];
}

export interface KeyInfo {
  /** pitch class 0..11 */
  tonic: number;
  mode: "major" | "minor";
  /** e.g. "C major", "A minor" */
  name: string;
}

export interface SongData {
  songId: string;
  title: string;
  /** right-hand melody notes */
  melody: NoteEvent[];
  /** one chord per bar, covering the melody span */
  chords: ChordEvent[];
  key: KeyInfo;
  bpm: number;
  /** seconds */
  duration: number;
}

export type Difficulty = "easy" | "medium" | "hard";
export type HandMode = "right" | "left" | "both";
