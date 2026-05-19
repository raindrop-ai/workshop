import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Activity, Bookmark, Search, Settings } from "lucide-react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { RaindropLogo } from "./RaindropLogo";

export type Page = "runs" | "search" | "saved" | "settings";

const NAV_ITEMS: { id: Page; label: string; path: string; icon: typeof Activity }[] = [
  { id: "runs", label: "runs", path: "/runs", icon: Activity },
  { id: "search", label: "search", path: "/search", icon: Search },
  { id: "saved", label: "saved", path: "/saved", icon: Bookmark },
];

const WORKSHOP_LOGO_URL = `${__RAINDROP_ASSETS_BASE_URL__}/assets/workshop/${encodeURIComponent(__RAINDROP_VERSION__)}/logo.svg`;

function isNavPathActive(pathname: string, path: string): boolean {
  return pathname === path || pathname.startsWith(`${path}/`);
}

function NavSidebarInner() {
  const { state } = useSidebar();
  const expanded = state === "expanded";
  const location = useLocation();
  const navigate = useNavigate();
  const onSettings = location.pathname === "/settings";

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="px-2 pt-1 pb-0">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              asChild
              className="cursor-pointer group/logo !bg-transparent hover:!bg-transparent active:!bg-transparent"
            >
              <a
                href="https://raindrop.ai"
                target="_blank"
                rel="noopener noreferrer"
              >
                <RaindropLogo size={10} className="text-white opacity-30 shrink-0 transition-all duration-200 group-hover/logo:opacity-100 group-hover/logo:drop-shadow-[0_0_6px_rgba(255,255,255,0.6)]" />
                <img
                  src={WORKSHOP_LOGO_URL}
                  alt=""
                  aria-hidden="true"
                  width={1}
                  height={1}
                  style={{ position: "absolute", opacity: 0, pointerEvents: "none" }}
                />
                {expanded && (
                  <span
                    className="text-[13px] -ml-px transition-all duration-200 group-hover/logo:!text-white/80"
                    style={{
                      fontFamily: '"AlphaLyrae", sans-serif',
                      color: "rgba(255,255,255,0.4)",
                    }}
                  >
                    raindrop
                  </span>
                )}
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map(({ id, label, path, icon: Icon }) => (
                <SidebarMenuItem key={id}>
                  {(() => {
                    const active = isNavPathActive(location.pathname, path);
                    return (
                  <SidebarMenuButton
                    tooltip={label}
                    asChild
                    isActive={active}
                    size="sm"
                  >
                    <NavLink to={path} end={false}>
                      <Icon
                        className={`size-3.5 shrink-0 transition-all duration-150 group-hover/menu-item:scale-105 ${active ? "opacity-100" : "opacity-45 group-hover/menu-item:opacity-80"}`}
                      />
                      <span
                        className={`text-[11px] transition-opacity duration-150 ${active ? "opacity-100" : "opacity-45 group-hover/menu-item:opacity-80"}`}
                      >
                        {label}
                      </span>
                    </NavLink>
                  </SidebarMenuButton>
                    );
                  })()}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="settings"
              isActive={onSettings}
              onClick={() => navigate(onSettings ? "/runs" : "/settings")}
              size="sm"
            >
              <Settings
                className={`size-3.5 shrink-0 transition-all duration-150 group-hover/menu-item:scale-105 ${onSettings ? "opacity-100" : "opacity-45 group-hover/menu-item:opacity-80"}`}
              />
              <span
                className={`text-[11px] transition-opacity duration-150 ${onSettings ? "opacity-100" : "opacity-45 group-hover/menu-item:opacity-80"}`}
              >
                settings
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

export function NavSidebar() {
  return <NavSidebarInner />;
}
