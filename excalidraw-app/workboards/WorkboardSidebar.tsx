import { Sidebar } from "@excalidraw/excalidraw";
import {
  copyIcon,
  PlusIcon,
  pencilIcon,
  TrashIcon,
} from "@excalidraw/excalidraw/components/icons";
import clsx from "clsx";

import "./WorkboardSidebar.scss";

import type { Workboard } from "./data";

export const WORKBOARDS_SIDEBAR_NAME = "workboards";

const formatRelativeTime = (timestamp: number): string => {
  const diff = Date.now() - timestamp;
  if (!Number.isFinite(diff) || diff < 0) {
    return "";
  }
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${days}d ago`;
  }
  return new Date(timestamp).toLocaleDateString();
};

export const WorkboardSidebar = ({
  boards,
  activeBoardId,
  thumbnails,
  disabled = false,
  onSwitch,
  onCreate,
  onRename,
  onDuplicate,
  onDelete,
}: {
  boards: Workboard[];
  activeBoardId: string | null;
  thumbnails: Record<string, string>;
  /** disable board management (e.g. while collaborating) */
  disabled?: boolean;
  onSwitch: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
}) => {
  return (
    <Sidebar name={WORKBOARDS_SIDEBAR_NAME} docked>
      <Sidebar.Header>
        <div className="workboard-sidebar__title">Workboards</div>
      </Sidebar.Header>
      <div className="workboard-sidebar">
        {disabled && (
          <div className="workboard-sidebar__note">
            Stop collaborating to manage boards.
          </div>
        )}
        <button
          type="button"
          className="workboard-sidebar__new"
          onClick={onCreate}
          disabled={disabled}
        >
          {PlusIcon}
          <span>New board</span>
        </button>
        <div className="workboard-sidebar__list">
          {boards.length === 0 && (
            <div className="workboard-sidebar__empty">No boards yet</div>
          )}
          {boards.map((board) => {
            const isActive = board.id === activeBoardId;
            return (
              <div
                key={board.id}
                className={clsx("workboard-card", {
                  "workboard-card--active": isActive,
                  "workboard-card--disabled": disabled,
                })}
                role="button"
                tabIndex={0}
                aria-pressed={isActive}
                aria-disabled={disabled}
                onClick={() => !disabled && onSwitch(board.id)}
                onKeyDown={(event) => {
                  if (
                    !disabled &&
                    (event.key === "Enter" || event.key === " ")
                  ) {
                    event.preventDefault();
                    onSwitch(board.id);
                  }
                }}
              >
                <div className="workboard-card__thumb">
                  {thumbnails[board.id] ? (
                    <img src={thumbnails[board.id]} alt="" draggable={false} />
                  ) : (
                    <span className="workboard-card__thumb-placeholder">
                      {board.name.trim().slice(0, 1).toUpperCase() || "?"}
                    </span>
                  )}
                </div>
                <div className="workboard-card__meta">
                  <div className="workboard-card__name" title={board.name}>
                    {board.name}
                  </div>
                  <div className="workboard-card__date">
                    {formatRelativeTime(board.updatedAt)}
                  </div>
                </div>
                <div
                  className="workboard-card__actions"
                  onClick={(event) => event.stopPropagation()}
                >
                  <button
                    type="button"
                    title="Rename"
                    aria-label={`Rename ${board.name}`}
                    disabled={disabled}
                    onClick={() => onRename(board.id)}
                  >
                    {pencilIcon}
                  </button>
                  <button
                    type="button"
                    title="Duplicate"
                    aria-label={`Duplicate ${board.name}`}
                    disabled={disabled}
                    onClick={() => onDuplicate(board.id)}
                  >
                    {copyIcon}
                  </button>
                  <button
                    type="button"
                    title={
                      boards.length <= 1
                        ? "Can't delete the only board"
                        : "Delete"
                    }
                    aria-label={`Delete ${board.name}`}
                    disabled={disabled || boards.length <= 1}
                    onClick={() => onDelete(board.id)}
                  >
                    {TrashIcon}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Sidebar>
  );
};
