import { MutableRefObject, useRef, useState } from "react";

import { NoteModel } from "@/types/types";
import { useLocalStorage } from "./useLocalStorage";

export const useNote = () => {
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
     const [notes, setNotes] = useLocalStorage<NoteModel[]>('notes', []);
   
     const createNote = (): NoteModel => {
       const newNote: NoteModel = {
         ...initialNote,
         id: crypto.randomUUID(),
         createdAt: new Date(),
       };
       noteRef.current = newNote;
       return newNote;
     };
   
     const updateNote = () => {
       setCurrentNote(noteRef);
       const noteIndex = notes.findIndex((n) => n.id === noteRef.current.id);
       if (noteIndex >= 0) {
         const updatedNotes = [...notes];
         updatedNotes[noteIndex] = noteRef.current;
         setNotes(updatedNotes);
       }
     };
   
     const deleteNote = (id: string) => {
       const updatedNotes = notes.filter((n) => n.id !== id);
       setNotes(updatedNotes);
   
       if (currentNote.current.id === id || updatedNotes.length === 0) {
         currentNote.current = initialNote;
         updateNote();
       }
     };
   
     const renameNote = (id: string, newName: string) => {
       const updatedNotes = notes.map((n: { id: string; }) =>
         n.id === id ? { ...n, transcript: newName } : n
       );
       setNotes(updatedNotes);
   
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
     };
   };