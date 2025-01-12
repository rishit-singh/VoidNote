import { MutableRefObject, useEffect, useRef, useState } from "react";

import { NoteModel } from "@/types/types";
import { useAuth } from "@/Context/AuthContext";

export const useNote = () => {
  const { session } = useAuth();
  const userId = session?.user?.id;
  
  const initialNote: NoteModel = {
    id: '',
    transcript: '',
    diarizationResults: [],
    createdAt: null,
    audio: null,
    url: null,
  };

  const noteRef = useRef<NoteModel>(initialNote);
  const [currentNote, setCurrentNote] = useState<MutableRefObject<NoteModel>>(noteRef);

  // Get user-specific notes using userId in the key
  const getUserNotes = (): NoteModel[] => {
    if (!userId) return [];
    
    try {
      const userNotes = localStorage.getItem(`notes_${userId}`);
      return userNotes ? JSON.parse(userNotes) : [];
    } catch (error) {
      console.error('Error retrieving notes:', error);
      return [];
    }
  };

  const [notes, setNotes] = useState<NoteModel[]>(getUserNotes());

  // Save notes with user-specific key
  const saveNotes = (updatedNotes: NoteModel[]) => {
    if (!userId) return;
    
    try {
      localStorage.setItem(`notes_${userId}`, JSON.stringify(updatedNotes));
    } catch (error) {
      console.error('Error saving notes:', error);
    }
  };

  // Update notes when user changes
  useEffect(() => {
    const userNotes = getUserNotes();
    setNotes(userNotes);
    
    // Reset current note when user changes
    noteRef.current = initialNote;
    setCurrentNote(noteRef);
  }, [userId]);

  const createNote = (): NoteModel => {
    if (!userId) {
      throw new Error('Must be signed in to create notes');
    }
    
    const newNote: NoteModel = {
      ...initialNote,
      id: crypto.randomUUID(),
      createdAt: new Date(),
    };
    noteRef.current = newNote;
    return newNote;
  };

  const updateNote = () => {
    if (!userId) return;
    
    setCurrentNote(noteRef);
    const noteIndex = notes.findIndex((n) => n.id === noteRef.current.id);
    
    if (noteIndex >= 0) {
      const updatedNotes = [...notes];
      updatedNotes[noteIndex] = noteRef.current;
      setNotes(updatedNotes);
      saveNotes(updatedNotes);
    } else if (noteRef.current.id) {
      const updatedNotes = [...notes, noteRef.current];
      setNotes(updatedNotes);
      saveNotes(updatedNotes);
    }
  };

  const deleteNote = (id: string) => {
    if (!userId) return;
    
    const updatedNotes = notes.filter((n) => n.id !== id);
    setNotes(updatedNotes);
    saveNotes(updatedNotes);

    if (currentNote.current.id === id || updatedNotes.length === 0) {
      currentNote.current = initialNote;
      updateNote();
    }
  };

  const renameNote = (id: string, newName: string) => {
    if (!userId) return;
    
    const updatedNotes = notes.map((n) =>
      n.id === id ? { ...n, transcript: newName } : n
    );
    setNotes(updatedNotes);
    saveNotes(updatedNotes);

    if (currentNote.current.id === id) {
      noteRef.current.transcript = newName;
      updateNote();
    }
  };

  return {
    noteRef,
    currentNote,
    notes,
    setNotes,
    createNote,
    updateNote,
    deleteNote,
    renameNote,
    isAuthenticated: !!userId,
  };
};