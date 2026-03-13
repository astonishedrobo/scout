#!/usr/bin/env python3
import argparse
import subprocess
import sys
import os
import signal
from pathlib import Path

# Paths
ROOT_DIR = Path(__file__).parent.resolve()
SCOUT_ENTRY = ROOT_DIR / "packages" / "scout" / "dist" / "index.js"

def run_cmd(cmd, cwd=ROOT_DIR):
    """Run a command and exit on failure."""
    print(f"Running: {' '.join(cmd)}")
    try:
        subprocess.check_call(cmd, cwd=str(cwd), env=os.environ)
    except subprocess.CalledProcessError as e:
        print(f"Error: Command failed with exit code {e.returncode}")
        sys.exit(e.returncode)

def build():
    """Build the monorepo."""
    print("Building Scout Project...")
    if not (ROOT_DIR / "node_modules").exists():
        run_cmd(["npm", "install"])
    
    # Sequential build to avoid memory/race issues in some environments
    run_cmd(["npm", "run", "build:core"])
    run_cmd(["npm", "run", "build:gui"])
    run_cmd(["npm", "run", "build:scout"])
    print("✓ Build complete")

def launch(port=3030, multi_user=False, config=None):
    """Launch the Scout GUI server."""
    if not SCOUT_ENTRY.exists():
        print("Build artifacts missing. Auto-building...")
        build()

    cmd = ["node", str(SCOUT_ENTRY), "--gui"]
    if multi_user:
        cmd.append("--multi-user")
    if port:
        cmd.extend(["-p", str(port)])
    if config:
        cmd.extend(["--config", str(config)])

    print(f"Launching Scout Server on port {port}...")
    try:
        # Use Popen so we can handle signals in Python
        proc = subprocess.Popen(cmd, cwd=str(ROOT_DIR), env=os.environ)
        
        def signal_handler(sig, frame):
            print("\nShutting down...")
            proc.terminate()
            sys.exit(0)
            
        signal.signal(signal.SIGINT, signal_handler)
        signal.signal(signal.SIGTERM, signal_handler)
        
        proc.wait()
    except KeyboardInterrupt:
        pass

def main():
    parser = argparse.ArgumentParser(description="Scout Launch & Deploy Helper")
    parser.add_argument("--build", action="store_true", help="Build the project before launching")
    parser.add_argument("--multi-user", action="store_true", help="Launch in multi-user server mode")
    parser.add_argument("-p", "--port", type=int, default=3030, help="Port to listen on (default: 3030)")
    parser.add_argument("-c", "--config", type=str, help="Path to custom config YAML")
    parser.add_argument("--docker", action="store_true", help="Launch via Docker Compose")

    args = parser.parse_args()

    if args.docker:
        print("Launching via Docker Compose...")
        run_cmd(["docker", "compose", "up", "--build", "-d"])
        print(f"✓ Docker containers started. GUI will be available at http://localhost:{args.port}")
        return

    if args.build or not SCOUT_ENTRY.exists():
        build()

    launch(port=args.port, multi_user=args.multi_user, config=args.config)

if __name__ == "__main__":
    main()
