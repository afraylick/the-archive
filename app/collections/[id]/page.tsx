import Library from '../../library';

export default async function CollectionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Library key={id} collectionId={id}/>;
}
