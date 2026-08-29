export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 font-extrabold tracking-tight ${className}`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- tiny static local asset, next/image is unneeded overhead here */}
      <img src="/logo-mark.png" alt="" className="h-[0.9em] w-auto shrink-0" />
      Stock<span className="text-ai">Off</span>
    </span>
  );
}
