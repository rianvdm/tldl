import { useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { RadioGroup, RadioGroupItem } from './ui/radio-group';
import { Card } from './ui/card';
import { TEMPLATES } from '../data/mockData';
import { Sparkles, CircleAlert } from 'lucide-react';
import { Alert, AlertDescription } from './ui/alert';

interface SubmitFormProps {
  onSubmit: (jobId: string) => void;
  onCancel: () => void;
}

export function SubmitForm({ onSubmit, onCancel }: SubmitFormProps) {
  const [url, setUrl] = useState('');
  const [templateId, setTemplateId] = useState('key-takeaways');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const validateUrl = (url: string): boolean => {
    // Basic validation for Apple Podcasts URL
    const pattern = /podcasts\.apple\.com.*\?i=/i;
    return pattern.test(url);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!url.trim()) {
      setError('Please enter a podcast episode URL');
      return;
    }

    if (!validateUrl(url)) {
      setError('Please enter a valid Apple Podcasts episode URL. It should look like: podcasts.apple.com/...?i=...');
      return;
    }

    setIsSubmitting(true);

    // Simulate API call
    setTimeout(() => {
      const jobId = `job-${Date.now()}`;
      onSubmit(jobId);
    }, 500);
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h2>Submit Episode</h2>
        <p className="text-muted-foreground mt-1">
          Generate an AI summary from any Apple Podcasts episode
        </p>
      </div>

      <Card className="p-6">
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* URL Input */}
          <div className="space-y-2">
            <Label htmlFor="url">Apple Podcasts Episode URL</Label>
            <Input
              id="url"
              type="url"
              placeholder="https://podcasts.apple.com/us/podcast/..."
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setError('');
              }}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Paste the URL from an Apple Podcasts episode page
            </p>
          </div>

          {/* Template Selection */}
          <div className="space-y-3">
            <Label>Summary Template</Label>
            <RadioGroup value={templateId} onValueChange={setTemplateId}>
              {Object.entries(TEMPLATES).map(([id, template]) => (
                <div key={id} className="flex items-start space-x-3 space-y-0">
                  <RadioGroupItem value={id} id={id} className="mt-1" />
                  <div className="flex-1">
                    <Label htmlFor={id} className="cursor-pointer">
                      <div>{template.name}</div>
                      <div className="text-xs text-muted-foreground font-normal mt-0.5">
                        {template.description}
                      </div>
                    </Label>
                  </div>
                </div>
              ))}
            </RadioGroup>
          </div>

          {/* Error Display */}
          {error && (
            <Alert variant="destructive">
              <CircleAlert className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Info Box */}
          <Alert>
            <Sparkles className="h-4 w-4" />
            <AlertDescription>
              Episodes are limited to 80 minutes. Transcripts and summaries are cached for 365 days and available publicly.
            </AlertDescription>
          </Alert>

          {/* Actions */}
          <div className="flex items-center gap-3 pt-2">
            <Button
              type="submit"
              disabled={isSubmitting}
              className="gap-2"
            >
              {isSubmitting ? (
                <>
                  <div className="h-4 w-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  Processing...
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4" />
                  Generate Summary
                </>
              )}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={onCancel}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
          </div>
        </form>
      </Card>

      {/* Example URL */}
      <div className="text-center">
        <button
          type="button"
          onClick={() => setUrl('https://podcasts.apple.com/us/podcast/the-knowledge-project/id990149481?i=1000638000000')}
          className="text-sm text-muted-foreground hover:text-foreground transition-colors underline"
        >
          Try an example URL
        </button>
      </div>
    </div>
  );
}
