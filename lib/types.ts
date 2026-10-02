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
  /** every transcribed note, played in order */
  melody: NoteEvent[];
  /**
   * Real left-hand notes, when the source provides them (MIDI uploads with a
   * genuine two-hand part). Absent for audio transcription, where the left
   * hand is synthesized from the chord progression instead.
   */
  left?: NoteEvent[];
  /** one chord per bar, covering the melody span */
  chords: ChordEvent[];
  key: KeyInfo;
  bpm: number;
  /** seconds */
  duration: number;
}

export type Difficulty = "easy" | "medium" | "hard";
export type HandMode = "right" | "left" | "both";

/** A marked section of the tutorial video, in seconds. */
export interface Section {
  start: number;
  end: number;
}

/** One sheet-music candidate from the MuseScore search (free scores only). */
export interface SheetCandidate {
  /** stable id used by /api/song/build to fetch the score */
  id: string;
  title: string;
  artist: string;
  /** public page on musescore.com */
  url: string;
  /** number of pages, when known */
  pages?: number;
  /** community rating 0..5, when known */
  rating?: number;
  /** instruments/parts label, e.g. "Piano" */
  instruments?: string;
}
