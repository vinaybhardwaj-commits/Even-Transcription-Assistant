import { redirect } from 'next/navigation';

// Folded into Observability as the "Right Care runs" tab (one forensic surface).
// Old links resolve here. The runs-browser client lives alongside and is imported
// by the Observability page.
export default function AppropriatenessRunsRedirect() {
  redirect('/admin/observability?tab=rightcare');
}
