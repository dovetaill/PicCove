pub fn valid_username(username: &str) -> bool {
    (3..=32).contains(&username.len())
        && username
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

pub const CLEAR_TOTP: &str = "totp_secret=NULL, totp_pending=NULL, totp_pending_until=NULL,
    totp_last_step=-1, totp_recovery_hashes='[]'::jsonb";
