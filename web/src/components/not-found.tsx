export function NotFound() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 bg-background text-center">
      <p className="text-sm text-muted-foreground">This page could not be found.</p>
      <a href="/" className="text-sm text-primary underline-offset-4 hover:underline">
        Back to teams-lite
      </a>
    </div>
  );
}
