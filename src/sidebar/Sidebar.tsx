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
    <div className="w-72 border-r border-gray-700 bg-gray-900 flex flex-col">
      <div className="p-6 relative">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 p-0 absolute top-2 right-2"
          onClick={onClose}
        >
          <ArrowLeft className="h-4 w-4 text-white" />
        </Button>
        <h1 className="text-2xl font-bold mb-6">YapNote</h1>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-medium">All Notes</h2>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 p-0"
            onClick={onNoteCreate}
          >
            <Plus className="h-4 w-4 text-white" />
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