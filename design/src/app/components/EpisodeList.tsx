import { mockEpisodes, getSummariesByEpisodeId, formatDuration, formatDate, TEMPLATES } from '../data/mockData';
import { Badge } from './ui/badge';
import { Card } from './ui/card';
import { ArrowRight } from 'lucide-react';

interface EpisodeListProps {
  onViewEpisode: (id: string) => void;
}

export function EpisodeList({ onViewEpisode }: EpisodeListProps) {
  return (
    <div className="space-y-6">
      <div>
        <h2>Recent Episodes</h2>
        <p className="text-muted-foreground mt-1">
          Browse AI-generated summaries from podcast episodes
        </p>
      </div>

      <div className="grid gap-4">
        {mockEpisodes.map((episode) => {
          const summaries = getSummariesByEpisodeId(episode.id);
          const availableTemplates = summaries.map(s => s.templateId);

          return (
            <Card
              key={episode.id}
              className="p-5 hover:bg-accent/50 transition-colors cursor-pointer group"
              onClick={() => onViewEpisode(episode.id)}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-muted-foreground mb-1">
                    {episode.podcastName}
                  </div>
                  <h3 className="mb-2 group-hover:text-primary transition-colors">
                    {episode.episodeTitle}
                  </h3>
                  <div className="flex items-center gap-3 text-sm text-muted-foreground mb-3">
                    <span>{formatDate(episode.episodeDate)}</span>
                    <span>•</span>
                    <span>{formatDuration(episode.episodeDuration)}</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {availableTemplates.map((templateId) => (
                      <Badge key={templateId} variant="secondary">
                        {TEMPLATES[templateId as keyof typeof TEMPLATES]?.name || templateId}
                      </Badge>
                    ))}
                  </div>
                </div>
                <div className="flex-shrink-0">
                  <div className="size-9 rounded-full bg-accent group-hover:bg-accent-foreground/10 transition-colors flex items-center justify-center">
                    <ArrowRight className="size-5 text-muted-foreground group-hover:text-foreground transition-colors" />
                  </div>
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      {mockEpisodes.length === 0 && (
        <div className="text-center py-12">
          <p className="text-muted-foreground">
            No episodes yet. Submit your first podcast episode to get started!
          </p>
        </div>
      )}
    </div>
  );
}
