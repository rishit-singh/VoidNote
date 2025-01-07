import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useEffect, useRef, useState } from "react";

import { MoreHorizontal } from "lucide-react";
import { NoteModel } from "@/types/types";

interface NoteEntryProps {
     note: NoteModel;
     isSelected: boolean;
     onSelect: (note: NoteModel) => void;
     onRename: (id: string, newName: string) => void;
     onDelete: (id: string) => void;
   }
   
   const NoteEntry: React.FC<NoteEntryProps> = ({
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
           isSelected ? 'bg-gray-800' : 'hover:bg-gray-700'
         } transition-colors`}
       >
         {isEditing ? (
           <input
             ref={inputRef}
             className="flex-grow text-white bg-transparent border border-gray-600 rounded-md px-2 py-1 focus:outline-none"
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
             className="text-white flex-grow truncate cursor-pointer"
             onClick={() => onSelect(note)}
           >
             {currentName}
           </span>
         )}
   
         <DropdownMenu>
           <DropdownMenuTrigger>
             <MoreHorizontal className="h-4 w-4" />
           </DropdownMenuTrigger>
           <DropdownMenuContent className="bg-gray-800 text-white rounded-md">
             <DropdownMenuItem
               className="cursor-pointer hover:bg-gray-700"
               onClick={() => setIsEditing(true)}
             >
               Rename
             </DropdownMenuItem>
             <DropdownMenuItem
               className="cursor-pointer hover:bg-gray-700"
               onClick={() => onDelete(note.id)}
             >
               Delete
             </DropdownMenuItem>
           </DropdownMenuContent>
         </DropdownMenu>
       </div>
     );
   };


   export default NoteEntry;