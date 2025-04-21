import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useEffect, useRef, useState } from "react";

import { MoreHorizontal, MoreVertical } from "lucide-react";
import { NoteModel } from "@/types/types";
import { Button } from "@/components/ui/button";

interface NoteEntryProps {
     note: NoteModel;
     isSelected: boolean;
     onSelect: (note: NoteModel) => void;
     onRename: (id: string, newName: string) => void;
     onDelete: (id: string) => void;
   }
   
   export const NoteEntry: React.FC<NoteEntryProps> = ({
     note,
     isSelected,
     onSelect,
     onRename,
     onDelete,
   }) => {
     const [isEditing, setIsEditing] = useState(false);
     const [currentName, setCurrentName] = useState(note.transcript || `Note ${note.id.split('-')[0]}`);
     const inputRef = useRef<HTMLInputElement>(null);
   
     useEffect(() => {
       if (isEditing && inputRef.current) {
         inputRef.current.focus();
         inputRef.current.select();
       }
     }, [isEditing]);
   
     const handleSave = () => {
       const newName = currentName.trim();
       if (newName) {
         onRename(note.id, newName);
       }
       setIsEditing(false);
     };
   
     return (
       <div
         className={`w-full flex items-center justify-between px-3 py-2 rounded-md ${
           isSelected ? 'bg-neutral-800' : 'hover:bg-neutral-800/50'
         } transition-colors group`}
       >
         {isEditing ? (
           <input
             ref={inputRef}
             className="flex-grow text-white bg-neutral-900 border border-neutral-700 rounded-md px-2 py-1 focus:outline-none focus:border-neutral-600"
             value={currentName}
             onChange={(e) => setCurrentName(e.target.value)}
             onBlur={handleSave}
             onKeyDown={(e) => {
               if (e.key === 'Enter') handleSave();
               if (e.key === 'Escape') {
                 setIsEditing(false);
                 setCurrentName(note.transcript || `Note ${note.id.split('-')[0]}`);
               }
             }}
           />
         ) : (
           <span
             className="text-neutral-300 flex-grow truncate cursor-pointer hover:text-white"
             onClick={() => onSelect(note)}
           >
             {currentName}
           </span>
         )}
   
         <Button
           variant="ghost"
           size="icon"
           className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 text-neutral-400 hover:text-white hover:bg-neutral-700"
           onClick={() => setIsEditing(true)}
         >
           <MoreVertical className="h-4 w-4" />
         </Button>
       </div>
     );
   };


   export default NoteEntry;