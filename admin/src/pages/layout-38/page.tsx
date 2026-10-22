import { useState } from "react";
import {
  Toolbar,
  ToolbarActions,
  ToolbarHeading,
} from "@/components/layouts/layout-38/components/toolbar";
import { ModelSelector } from "@/components/layouts/layout-38/components/model-selector";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Share2 } from "lucide-react";

export function Layout38Page() {
  const [selectedModelId, setSelectedModelId] = useState<string>("gpt-4");

  return (
    <div className="container-fluid">
      <Toolbar>
        <div className="flex items-center gap-3">
          <ToolbarHeading>
            <ModelSelector
              selectedModelId={selectedModelId}
              onModelChange={setSelectedModelId}
            />
          </ToolbarHeading>
        </div>

        <ToolbarActions>
          <Button shape="circle" variant="mono">
            <Share2 />
            Share Chat
          </Button>
        </ToolbarActions>
      </Toolbar>

      <Skeleton
        className="rounded-lg grow h-[calc(100vh-7.2rem)] border border-dashed border-input bg-background text-subtle-stroke relative text-border"
        style={{
          backgroundImage:
            "repeating-linear-gradient(125deg, transparent, transparent 5px, currentcolor 5px, currentcolor 6px)",
        }}
      />
    </div>
  );
}
