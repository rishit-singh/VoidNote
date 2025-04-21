import { ArrowLeft, Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { NoteList } from '@/components/NoteList/NoteList';
import { NoteModel } from '@/types/types';
import SignOutButton from '@/components/SignOutButton';

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  notes: NoteModel[];
  currentNoteId: string;
  onNoteSelect: (note: NoteModel) => void;
  onNoteCreate: () => void;
  onNoteRename: (id: string, newName: string) => void;
  onNoteDelete: (id: string) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  isOpen,
  onClose,
  notes,
  currentNoteId,
  onNoteSelect,
  onNoteCreate,
  onNoteRename,
  onNoteDelete,
}) => {
  if (!isOpen) return null;

  return (
    <div className="w-72 border-r border-neutral-800 bg-[#0F1117] flex flex-col">
      <div className="p-6 relative">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 p-0 absolute top-2 right-2 text-neutral-400 hover:text-white hover:bg-neutral-800"
          onClick={onClose}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-2xl font-bold mb-6 text-white">VoidNote</h1>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-medium text-neutral-400">All Notes</h2>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 p-0 text-neutral-400 hover:text-white hover:bg-neutral-800"
            onClick={onNoteCreate}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <NoteList
          notes={notes}
          currentNoteId={currentNoteId}
          onNoteSelect={onNoteSelect}
          onNoteCreate={onNoteCreate}
          onNoteRename={onNoteRename}
          onNoteDelete={onNoteDelete}
        />
      </div>
      <SignOutButton />
    </div>
  );
};