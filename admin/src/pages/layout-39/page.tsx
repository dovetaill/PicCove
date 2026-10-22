import { Plus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Toolbar,
  ToolbarHeading,
  ToolbarPageTitle,
  ToolbarDescription,
  ToolbarActions,
} from "@/components/layouts/layout-39/components/toolbar";
import { ToolbarSearch } from "@/components/layouts/layout-39/components/toolbar-search";
import { Pattern } from "@/components/layouts/layout-39/components/pattern";
import { useLayout } from "@/components/layouts/layout-39/components/context";

export function Layout39Page() {
  const {isMobile} = useLayout();
  const { isAsideOpen, asideToggle } = useLayout();

  return (
    <div className="container-fluid py-5">
      <ToolbarSearch />
      <Toolbar>
        <div className="flex items-center gap-3">
          <ToolbarHeading>
            <ToolbarPageTitle>Today Activities</ToolbarPageTitle>
            <ToolbarDescription>Manage your reminders, to do list, events, etc.</ToolbarDescription>
          </ToolbarHeading>
        </div>
        <ToolbarActions>
          <Button variant="mono"><Plus />New Activity</Button>
          {!isMobile && !isAsideOpen && <Button mode="icon" variant="outline" onClick={asideToggle}><Sparkles className="size-4 text-purple-800" /></Button>}
        </ToolbarActions>
      </Toolbar>

      <Pattern className="rounded-lg grow h-screen border border-dashed border-input bg-background text-subtle-stroke relative text-border" />
    </div>
  );
}
