import os
import sqlite3
import logging
import jwt
from datetime import datetime, timedelta, timezone
from pathlib import Path
from fastapi import HTTPException, Security, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
import bcrypt
from pydantic import BaseModel
from ..secrets import load_secret

SECRET_KEY = load_secret("SCOUT_SECRET_KEY", "fallback_secret_key_for_dev_only_please_change")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 7  # 7 days

# Explicit admin roster — comma-separated usernames. When set, these users are
# always admin regardless of registration order.
_ADMIN_USERS_ENV: set[str] = {
    u.strip().lower()
    for u in os.environ.get("SCOUT_ADMIN_USERS", "").split(",")
    if u.strip()
}

security = HTTPBearer()

SCOUT_HOME = Path.home() / ".config" / "scout"
DB_PATH = SCOUT_HOME / "scout_users.db"
logger = logging.getLogger(__name__)


class User(BaseModel):
    id: int
    username: str


def init_db():
    SCOUT_HOME.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            hashed_password TEXT NOT NULL
        )
    """)
    try:
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS user_memory_preferences (
                user_id INTEGER PRIMARY KEY,
                use_memories INTEGER NOT NULL,
                generate_memories INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        """)
    except sqlite3.OperationalError as exc:
        if "readonly" not in str(exc).lower():
            raise
        logger.warning("Could not initialize user memory preferences: %s", exc)
    conn.commit()

    # Migration: add is_admin column if it doesn't exist yet
    cursor.execute("PRAGMA table_info(users)")
    cols = {row[1] for row in cursor.fetchall()}
    if "is_admin" not in cols:
        cursor.execute("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0")
        cursor.execute("UPDATE users SET is_admin = 1 WHERE id = (SELECT MIN(id) FROM users)")
        conn.commit()

    cursor.execute("PRAGMA table_info(users)")
    cols = {row[1] for row in cursor.fetchall()}
    if "permission_profile" not in cols:
        cursor.execute(
            "ALTER TABLE users ADD COLUMN permission_profile TEXT NOT NULL DEFAULT 'contributor'"
        )
        cursor.execute(
            "UPDATE users SET permission_profile = 'admin' WHERE is_admin = 1"
        )
        conn.commit()

    # Apply SCOUT_ADMIN_USERS: promote listed usernames, demote everyone else
    # (only when the env var is explicitly set)
    if _ADMIN_USERS_ENV:
        placeholders = ",".join("?" * len(_ADMIN_USERS_ENV))
        cursor.execute(
            f"UPDATE users SET permission_profile='admin', is_admin=1 WHERE lower(username) IN ({placeholders})",
            list(_ADMIN_USERS_ENV),
        )
        cursor.execute(
            f"UPDATE users SET permission_profile='contributor', is_admin=0 WHERE lower(username) NOT IN ({placeholders})",
            list(_ADMIN_USERS_ENV),
        )
        conn.commit()

    conn.close()


# Call init_db on import
init_db()


def verify_password(plain_password: str, hashed_password: str):
    return bcrypt.checkpw(
        plain_password.encode('utf-8'),
        hashed_password.encode('utf-8')
    )


def get_password_hash(password: str):
    return bcrypt.hashpw(
        password.encode('utf-8'),
        bcrypt.gensalt()
    ).decode('utf-8')


def create_access_token(data: dict, expires_delta: timedelta | None = None):
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.now(timezone.utc) + expires_delta
    else:
        expire = datetime.now(timezone.utc) + timedelta(minutes=15)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt


def _user_row_to_dict(row: tuple, *, with_password: bool = False) -> dict:
    d = {
        "id": row[0],
        "username": row[1],
        "is_admin": bool(row[3]),
        "permission_profile": row[4] if len(row) > 4 else "contributor",
    }
    if with_password:
        d["hashed_password"] = row[2]
    return d


def get_user_by_username(username: str):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute(
        "SELECT id, username, hashed_password, is_admin, permission_profile FROM users WHERE username = ?",
        (username,),
    )
    row = cursor.fetchone()
    conn.close()
    if row:
        return _user_row_to_dict(row, with_password=True)
    return None


def get_user_by_id(user_id: int):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute(
        "SELECT id, username, hashed_password, is_admin, permission_profile FROM users WHERE id = ?",
        (user_id,),
    )
    row = cursor.fetchone()
    conn.close()
    if row:
        return _user_row_to_dict(row)
    return None


def get_user_permission_profile(user_id: int | str) -> str:
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute(
        "SELECT permission_profile, is_admin FROM users WHERE id = ?",
        (int(user_id),),
    )
    row = cursor.fetchone()
    conn.close()
    if not row:
        return "contributor"
    profile, is_admin = row[0], bool(row[1])
    if profile in ("analyst", "contributor", "admin"):
        return profile
    return "admin" if is_admin else "contributor"


def is_user_admin(user_id: int | str) -> bool:
    """DB-backed admin check from permission_profile (admin) or legacy is_admin."""
    return get_user_permission_profile(user_id) == "admin"


def get_user_memory_preferences(user_id: int | str) -> dict[str, bool] | None:
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    try:
        cursor.execute(
            """
            SELECT use_memories, generate_memories
            FROM user_memory_preferences WHERE user_id = ?
            """,
            (int(user_id),),
        )
    except sqlite3.OperationalError as exc:
        conn.close()
        if "no such table" in str(exc).lower():
            return None
        raise
    row = cursor.fetchone()
    conn.close()
    if row is None:
        return None
    return {
        "use_memories": bool(row[0]),
        "generate_memories": bool(row[1]),
    }


def set_user_memory_preferences(
    user_id: int | str,
    *,
    use_memories: bool,
    generate_memories: bool,
) -> None:
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """
        INSERT INTO user_memory_preferences (
            user_id, use_memories, generate_memories, updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
            use_memories=excluded.use_memories,
            generate_memories=excluded.generate_memories,
            updated_at=excluded.updated_at
        """,
        (int(user_id), int(use_memories), int(generate_memories), int(datetime.now().timestamp())),
    )
    conn.commit()
    conn.close()


def create_user(username: str, password: str):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT COUNT(*) FROM users")
        is_first = cursor.fetchone()[0] == 0
        # A user is admin if: explicitly listed in SCOUT_ADMIN_USERS, or is the
        # first ever registered user (fallback for zero-config deployments).
        is_admin = bool(_ADMIN_USERS_ENV and username.lower() in _ADMIN_USERS_ENV) or (
            not _ADMIN_USERS_ENV and is_first
        )
        profile = "admin" if is_admin else "contributor"
        cursor.execute(
            "INSERT INTO users (username, hashed_password, is_admin, permission_profile) VALUES (?, ?, ?, ?)",
            (username, get_password_hash(password), 1 if is_admin else 0, profile),
        )
        conn.commit()
        user_id = cursor.lastrowid
        return {"id": user_id, "username": username, "is_admin": is_admin}
    except sqlite3.IntegrityError:
        return None
    finally:
        conn.close()


def list_users() -> list[dict]:
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute(
        "SELECT id, username, hashed_password, is_admin, permission_profile FROM users ORDER BY id"
    )
    rows = cursor.fetchall()
    conn.close()
    return [_user_row_to_dict(r) for r in rows]


def set_user_admin(user_id: int, is_admin: bool) -> bool:
    profile = "admin" if is_admin else "contributor"
    return set_user_permission_profile(user_id, profile)


def set_user_permission_profile(user_id: int, profile: str) -> bool:
    from ..permissions import VALID_PROFILES

    if profile not in VALID_PROFILES:
        return False
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute(
        "UPDATE users SET permission_profile = ?, is_admin = ? WHERE id = ?",
        (profile, 1 if profile == "admin" else 0, user_id),
    )
    conn.commit()
    affected = cursor.rowcount
    conn.close()
    return affected > 0


async def get_current_user_optional(request: Request):
    auth_header = request.headers.get('Authorization')
    if not auth_header:
        return None
    scheme, _, token = auth_header.partition(" ")
    if scheme.lower() != "bearer" or not token:
        return None
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id = payload.get("sub")
        username: str = payload.get("username")
        if user_id is None:
            return None
        return User(id=int(user_id), username=username)
    except (jwt.PyJWTError, ValueError, TypeError):
        return None


async def get_current_user(credentials: HTTPAuthorizationCredentials = Security(security)):
    try:
        payload = jwt.decode(credentials.credentials, SECRET_KEY, algorithms=[ALGORITHM])
        user_id: int = payload.get("sub")
        username: str = payload.get("username")
        if user_id is None:
            raise HTTPException(status_code=401, detail="Invalid auth credentials")
        return User(id=int(user_id), username=username)
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid auth credentials")
