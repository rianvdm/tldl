import { useState, useEffect } from 'react';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Progress } from './ui/progress';
import { Alert, AlertDescription } from './ui/alert';
import { CircleCheck, CircleAlert, Loader, Clock, ArrowRight } from 'lucide-react';

interface JobStatusProps {
  jobId: string;
  onComplete: (episodeId: string) => void;
  onBack: () => void;
}

type JobStatus = 'queued' | 'fetching_metadata' | 'checking_transcript' | 'transcribing' | 'summarizing' | 'completed' | 'failed';

const STATUS_LABELS: Record<JobStatus, string> = {
  queued: 'Queued',
  fetching_metadata: 'Fetching episode metadata',
  checking_transcript: 'Checking for existing transcript',
  transcribing: 'Transcribing audio',
  summarizing: 'Generating summary',
  completed: 'Completed',
  failed: 'Failed',
};

const STATUS_PROGRESS: Record<JobStatus, number> = {
  queued: 5,
  fetching_metadata: 20,
  checking_transcript: 35,
  transcribing: 60,
  summarizing: 85,
  completed: 100,
  failed: 0,
};

export function JobStatus({ jobId, onComplete, onBack }: JobStatusProps) {
  const [status, setStatus] = useState<JobStatus>('queued');
  const [estimatedSeconds, setEstimatedSeconds] = useState<number | null>(120);
  const [error, setError] = useState<string | null>(null);

  // Simulate job progress
  useEffect(() => {
    const statuses: JobStatus[] = [
      'queued',
      'fetching_metadata',
      'checking_transcript',
      'transcribing',
      'summarizing',
      'completed',
    ];

    let currentIndex = 0;
    const interval = setInterval(() => {
      currentIndex++;
      if (currentIndex < statuses.length) {
        setStatus(statuses[currentIndex]);
        
        // Update estimated time
        if (currentIndex < statuses.length - 1) {
          setEstimatedSeconds((prev) => (prev ? Math.max(0, prev - 20) : null));
        }
      } else {
        clearInterval(interval);
        // Simulate completion after a short delay
        setTimeout(() => {
          onComplete('ep-001');
        }, 1000);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [onComplete]);

  const isCompleted = status === 'completed';
  const isFailed = status === 'failed';
  const isProcessing = !isCompleted && !isFailed;

  const formatEstimatedTime = (seconds: number | null): string => {
    if (!seconds) return '';
    const minutes = Math.ceil(seconds / 60);
    return minutes === 1 ? '~1 minute' : `~${minutes} minutes`;
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h2>Processing Episode</h2>
        <p className="text-muted-foreground mt-1">
          Job ID: <span className="font-mono text-xs">{jobId}</span>
        </p>
      </div>

      <Card className="p-6 space-y-6">
        {/* Progress Bar */}
        {isProcessing && (
          <div className="space-y-2">
            <Progress value={STATUS_PROGRESS[status]} className="h-2" />
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                {STATUS_PROGRESS[status]}% complete
              </span>
              {estimatedSeconds !== null && estimatedSeconds > 0 && (
                <span className="text-muted-foreground flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5" />
                  {formatEstimatedTime(estimatedSeconds)} remaining
                </span>
              )}
            </div>
          </div>
        )}

        {/* Status Steps */}
        <div className="space-y-3">
          {Object.entries(STATUS_LABELS).map(([stepStatus, label]) => {
            const isCurrentStep = status === stepStatus;
            const isPastStep = STATUS_PROGRESS[status] > STATUS_PROGRESS[stepStatus as JobStatus];
            const isFutureStep = STATUS_PROGRESS[status] < STATUS_PROGRESS[stepStatus as JobStatus];

            if (stepStatus === 'failed') return null;

            return (
              <div
                key={stepStatus}
                className={`flex items-center gap-3 p-3 rounded-lg transition-colors ${
                  isCurrentStep
                    ? 'bg-primary/10 text-foreground'
                    : isPastStep
                    ? 'bg-muted/50 text-muted-foreground'
                    : 'text-muted-foreground'
                }`}
              >
                <div className="flex-shrink-0">
                  {isPastStep || isCompleted ? (
                    <CircleCheck className="h-5 w-5 text-green-500" />
                  ) : isCurrentStep ? (
                    <Loader className="h-5 w-5 animate-spin" />
                  ) : (
                    <div className="h-5 w-5 rounded-full border-2 border-current opacity-30" />
                  )}
                </div>
                <div className="flex-1">
                  <div className={isCurrentStep ? 'font-medium' : ''}>{label}</div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Success State */}
        {isCompleted && (
          <Alert className="border-green-500/50 bg-green-500/10">
            <CircleCheck className="h-4 w-4 text-green-500" />
            <AlertDescription className="text-foreground">
              Summary generated successfully! Redirecting...
            </AlertDescription>
          </Alert>
        )}

        {/* Error State */}
        {isFailed && error && (
          <Alert variant="destructive">
            <CircleAlert className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* Actions */}
        <div className="flex items-center gap-3 pt-4">
          {isFailed && (
            <Button onClick={() => window.location.reload()} className="gap-2">
              <ArrowRight className="h-4 w-4" />
              Retry
            </Button>
          )}
          <Button variant="outline" onClick={onBack}>
            {isCompleted ? 'View All Episodes' : 'Back to Episodes'}
          </Button>
        </div>
      </Card>

      {/* Info */}
      {isProcessing && (
        <div className="text-center">
          <p className="text-sm text-muted-foreground">
            This page will automatically update. You can safely navigate away and return later.
          </p>
        </div>
      )}
    </div>
  );
}
