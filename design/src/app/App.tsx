import { useState, useEffect } from 'react';
import { EpisodeList } from './components/EpisodeList';
import { EpisodeDetail } from './components/EpisodeDetail';
import { SubmitForm } from './components/SubmitForm';
import { JobStatus } from './components/JobStatus';
import { Button } from './components/ui/button';
import { Plus, LayoutList, Sparkles } from 'lucide-react';
import { Toaster } from './components/ui/sonner';

type View = 
  | { type: 'list' }
  | { type: 'episode'; id: string }
  | { type: 'submit' }
  | { type: 'job'; id: string };

export default function App() {
  const [view, setView] = useState<View>({ type: 'list' });
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  // Set dark mode on mount
  useEffect(() => {
    document.documentElement.classList.add('dark');
  }, []);

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border sticky top-0 bg-background/95 backdrop-blur z-10">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <button
              onClick={() => setView({ type: 'list' })}
              className="flex items-center gap-2 hover:opacity-80 transition-opacity"
            >
              <div className="flex items-center gap-3">
                <div className="bg-gradient-to-br from-purple-500 to-pink-500 p-2 rounded-lg">
                  <Sparkles className="h-5 w-5 text-white" />
                </div>
                <div>
                  <h1 className="tracking-tight">TLDL</h1>
                  <p className="text-xs text-muted-foreground">Too Long Didn't Listen</p>
                </div>
              </div>
            </button>

            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setView({ type: 'list' })}
                className="gap-2"
              >
                <LayoutList className="h-4 w-4" />
                Episodes
              </Button>
              {isAuthenticated && (
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => setView({ type: 'submit' })}
                  className="gap-2"
                >
                  <Plus className="h-4 w-4" />
                  Submit
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsAuthenticated(!isAuthenticated)}
                className="ml-2"
              >
                {isAuthenticated ? 'Logout' : 'Login'}
              </Button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {view.type === 'list' && (
          <EpisodeList 
            onViewEpisode={(id) => setView({ type: 'episode', id })}
          />
        )}
        
        {view.type === 'episode' && (
          <EpisodeDetail
            episodeId={view.id}
            isAuthenticated={isAuthenticated}
            onBack={() => setView({ type: 'list' })}
            onRegenerate={(jobId) => setView({ type: 'job', id: jobId })}
            onDelete={() => setView({ type: 'list' })}
          />
        )}
        
        {view.type === 'submit' && (
          <SubmitForm
            onSubmit={(jobId) => setView({ type: 'job', id: jobId })}
            onCancel={() => setView({ type: 'list' })}
          />
        )}
        
        {view.type === 'job' && (
          <JobStatus
            jobId={view.id}
            onComplete={(episodeId) => setView({ type: 'episode', id: episodeId })}
            onBack={() => setView({ type: 'list' })}
          />
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-border mt-16">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <p className="text-center text-sm text-muted-foreground">
            TLDL uses AI to generate summaries from podcast transcripts. 
            <br />
            All content expires after 365 days.
          </p>
        </div>
      </footer>
      
      <Toaster />
    </div>
  );
}