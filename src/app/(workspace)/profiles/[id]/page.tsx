import { People } from "@/components/People";

export default async function ProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <People key={id} profileId={id} />;
}
