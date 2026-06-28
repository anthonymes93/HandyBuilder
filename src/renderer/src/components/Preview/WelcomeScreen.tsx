import { Monitor, FolderOpen, Zap, Eye } from 'lucide-react'

export function WelcomeScreen() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center bg-gray-950 gap-10 p-8">
      <div className="flex flex-col items-center gap-5">
        <div className="p-5 bg-blue-500/10 rounded-2xl border border-blue-500/20">
          <Monitor className="w-14 h-14 text-blue-400" />
        </div>
        <div className="text-center">
          <h1 className="text-3xl font-bold text-gray-100 tracking-tight">HandyBuilder</h1>
          <p className="text-gray-600 text-sm mt-2">Professional Web Development Environment</p>
        </div>
      </div>

      <div className="flex gap-4">
        <FeatureCard icon={<FolderOpen className="w-5 h-5 text-yellow-400" />} label="Open any Vite project" />
        <FeatureCard icon={<Zap className="w-5 h-5 text-blue-400" />} label="Auto-starts dev server" />
        <FeatureCard icon={<Eye className="w-5 h-5 text-green-400" />} label="Live preview" />
      </div>

      <p className="text-gray-800 text-xs">
        Click <span className="text-gray-600 font-medium">Open Project</span> in the sidebar to get started
      </p>
    </div>
  )
}

function FeatureCard({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex flex-col items-center gap-3 p-5 bg-gray-900 rounded-xl border border-gray-800 w-36">
      {icon}
      <span className="text-gray-500 text-xs text-center leading-relaxed">{label}</span>
    </div>
  )
}
