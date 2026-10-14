import { redirect } from 'next/navigation';

// Search merged into the Knowledge base (29-Jun IA decision). Old links resolve.
export default function SearchPage() {
  redirect('/knowledge');
}
