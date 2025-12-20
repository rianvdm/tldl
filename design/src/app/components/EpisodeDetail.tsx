import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  getEpisodeById,
  getSummariesByEpisodeId,
  getTranscriptByEpisodeId,
  formatDuration,
  formatDate,
  calculateDaysRemaining,
  TEMPLATES,
} from '../data/mockData';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { Card } from './ui/card';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from './ui/alert-dialog';
import { Download, Trash, RefreshCw, Clock, ChevronRight, ClipboardCopy, Sparkles } from 'lucide-react';
import { Separator } from './ui/separator';
import { toast } from 'sonner';

interface EpisodeDetailProps {
  episodeId: string;
  isAuthenticated: boolean;
  onBack: () => void;
  onRegenerate: (jobId: string) => void;
  onDelete: () => void;
}

export function EpisodeDetail({
  episodeId,
  isAuthenticated,
  onBack,
  onRegenerate,
  onDelete,
}: EpisodeDetailProps) {
  const episode = getEpisodeById(episodeId);
  const summaries = getSummariesByEpisodeId(episodeId);
  const transcript = getTranscriptByEpisodeId(episodeId);
  const [selectedTemplateId, setSelectedTemplateId] = useState(summaries[0]?.templateId || 'key-takeaways');

  if (!episode) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Episode not found</p>
        <Button onClick={onBack} variant="outline" className="mt-4">
          Go Back
        </Button>
      </div>
    );
  }

  const currentSummary = summaries.find(s => s.templateId === selectedTemplateId);
  const daysRemaining = calculateDaysRemaining(episode.expiresAt);

  // Get templates that don't have summaries yet
  const availableTemplates = Object.keys(TEMPLATES).filter(
    templateId => !summaries.find(s => s.templateId === templateId)
  );

  const handleGenerateSummary = (templateId: string) => {
    const jobId = `job-${Date.now()}`;
    toast.success(`Generating ${TEMPLATES[templateId as keyof typeof TEMPLATES].name}...`);
    onRegenerate(jobId);
  };

  const handleCopyMarkdown = () => {
    if (currentSummary) {
      navigator.clipboard.writeText(currentSummary.text);
      toast.success('Markdown copied to clipboard!');
    }
  };

  const handleDownloadPDF = () => {
    toast.info('PDF download would start here');
  };

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm">
        <button
          onClick={onBack}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          Episodes
        </button>
        <ChevronRight className="h-4 w-4 text-muted-foreground" />
        <span className="text-foreground">{episode.podcastName}</span>
      </div>

      {/* Episode Header */}
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <div className="text-sm text-muted-foreground mb-2">
              {episode.podcastName}
            </div>
            <h1 className="mb-3">{episode.episodeTitle}</h1>
            <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
              <span>{formatDate(episode.episodeDate)}</span>
              <span>•</span>
              <span>{formatDuration(episode.episodeDuration)}</span>
              <span>•</span>
              <div className="flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5" />
                <span>Expires in {daysRemaining} days</span>
              </div>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={handleDownloadPDF} variant="default" className="gap-2">
            <Download className="h-4 w-4" />
            Download PDF
          </Button>
          
          {isAuthenticated && (
            <>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" className="gap-2">
                    <Trash className="h-4 w-4" />
                    Delete
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete Episode</AlertDialogTitle>
                    <AlertDialogDescription>
                      Are you sure you want to delete this episode? This will remove the episode,
                      transcript, and all summaries. This action cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={onDelete}>Delete</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          )}
        </div>
      </div>

      <Separator />

      {/* Summary Tabs */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h3>Summary</h3>
          <Badge variant="outline" className="gap-1.5">
            <div className="h-2 w-2 rounded-full bg-green-500" />
            {episode.transcriptSource} transcript
          </Badge>
        </div>

        {summaries.length > 0 ? (
          <Tabs value={selectedTemplateId} onValueChange={setSelectedTemplateId}>
            <TabsList className="mb-6">
              {summaries.map((summary) => {
                const template = TEMPLATES[summary.templateId as keyof typeof TEMPLATES];
                return (
                  <TabsTrigger key={summary.templateId} value={summary.templateId}>
                    {template?.name || summary.templateId}
                  </TabsTrigger>
                );
              })}
            </TabsList>

            {summaries.map((summary) => {
              const template = TEMPLATES[summary.templateId as keyof typeof TEMPLATES];
              return (
                <TabsContent key={summary.templateId} value={summary.templateId} className="space-y-4">
                  <Card className="p-6">
                    <div className="flex items-center justify-between mb-4">
                      <div className="text-sm text-muted-foreground">
                        Generated with {summary.model}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleCopyMarkdown}
                        className="gap-2"
                      >
                        <ClipboardCopy className="h-4 w-4" />
                        Copy Markdown
                      </Button>
                    </div>
                    <div className="prose prose-sm dark:prose-invert max-w-none">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {summary.text}
                      </ReactMarkdown>
                    </div>
                  </Card>

                  {isAuthenticated && (
                    <div className="flex items-center justify-between p-4 bg-muted/50 rounded-lg">
                      <div className="text-sm text-muted-foreground">
                        Want a different perspective on this episode?
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleGenerateSummary(summary.templateId)}
                        className="gap-2"
                      >
                        <RefreshCw className="h-4 w-4" />
                        Regenerate
                      </Button>
                    </div>
                  )}
                </TabsContent>
              );
            })}
          </Tabs>
        ) : (
          <Card className="p-6">
            <p className="text-muted-foreground text-center">
              No summaries available for this episode yet.
            </p>
          </Card>
        )}

        {/* Generate Missing Summaries Section */}
        {isAuthenticated && availableTemplates.length > 0 && (
          <div className="mt-6">
            <h4 className="mb-3">Generate Additional Summaries</h4>
            <div className="grid gap-3">
              {availableTemplates.map((templateId) => {
                const template = TEMPLATES[templateId as keyof typeof TEMPLATES];
                return (
                  <Card key={templateId} className="p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-medium mb-1">{template.name}</div>
                        <div className="text-sm text-muted-foreground">
                          {template.description}
                        </div>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleGenerateSummary(templateId)}
                        className="gap-2"
                      >
                        <Sparkles className="h-4 w-4" />
                        Generate
                      </Button>
                    </div>
                  </Card>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <Separator />

      {/* Transcript Section */}
      <div>
        <h3 className="mb-4">Full Transcript</h3>
        {transcript ? (
          <Card className="p-6">
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <div className="whitespace-pre-wrap font-mono text-xs leading-relaxed">
                {transcript.text}
              </div>
            </div>
          </Card>
        ) : (
          <Card className="p-6">
            <p className="text-muted-foreground text-center">
              No transcript available for this episode.
            </p>
          </Card>
        )}
      </div>
    </div>
  );
}
