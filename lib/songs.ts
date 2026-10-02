import { supabase } from "./supabase";
import type { SongData } from "./types";

export interface SavedSong {
  id: string;
  title: string;
  song_data: SongData;
  created_at: string;
  updated_at: string;
}

/** Save a song to the user's Supabase account. */
export async function saveSong(title: string, songData: SongData): Promise<SavedSong> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("You must be logged in to save songs.");

  const { data, error } = await supabase
    .from("songs")
    .insert({
      user_id: user.id,
      title,
      song_data: songData,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to save song: ${error.message}`);
  return data as SavedSong;
}

/** Load all songs for the current user, newest first. */
export async function loadUserSongs(): Promise<SavedSong[]> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from("songs")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Failed to load songs: ${error.message}`);
  return (data || []) as SavedSong[];
}

/** Delete a saved song. */
export async function deleteSong(id: string): Promise<void> {
  const { error } = await supabase.from("songs").delete().eq("id", id);
  if (error) throw new Error(`Failed to delete song: ${error.message}`);
}
