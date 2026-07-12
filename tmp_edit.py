import re
import sys

with open('src/components/GitPanel/HistoryTab.tsx', 'r') as f:
    content = f.read()

old = (
    "import {\n"
    "  GitCommit as GitCommitIcon,\n"
    "  RefreshCw,\n"
    "  Loader2,\n"
    "  ChevronDown,\n"
    "  Search,\n"
    "  X,\n"
    "  FileClock,\n"
    "  GitBranch as GitBranchIcon,\n"
    "  ArrowLeft,\n"
    "  Copy,\n"
    "  GitMerge,\n"
    "  RotateCcw,\n"
    "} from 'lucide-react'"
)

new = (
    "import {\n"
    "  GitCommit as GitCommitIcon,\n"
    "  RefreshCw,\n"
    "  Loader2,\n"
    "  ChevronDown,\n"
    "  Search,\n"
    "  X,\n"
    "  FileClock,\n"
    "  GitBranch as GitBranchIcon,\n"
    "  ArrowLeft,\n"
    "  Copy,\n"
    "  GitMerge,\n"
    "  RotateCcw,\n"
    "  Undo2,\n"
    "  GitBranchPlus,\n"
    "  Tag,\n"
    "  Trash2,\n"
    "} from 'lucide-react'"
)

content_norm = content.replace('\r\n', '\n')
old_norm = old.replace('\r\n', '\n')
new_norm = new.replace('\r\n', '\n')

if old_norm not in content_norm:
    print("FAIL: old string not found", file=sys.stderr)
    sys.exit(1)

content_norm = content_norm.replace(old_norm, new_norm, 1)
print("OK")