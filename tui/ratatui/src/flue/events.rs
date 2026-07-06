#[derive(Debug, Clone, PartialEq)]
pub struct FlueEvent {
    pub event_type: String,
    pub event_index: Option<u64>,
    pub timestamp: Option<String>,
    pub value: serde_json::Value,
}

impl FlueEvent {
    pub fn from_value(value: serde_json::Value) -> Self {
        let event_type = value
            .get("type")
            .and_then(|event_type| event_type.as_str())
            .unwrap_or("unknown")
            .to_string();
        let event_index = value.get("eventIndex").and_then(|index| index.as_u64());
        let timestamp = value
            .get("timestamp")
            .and_then(|timestamp| timestamp.as_str())
            .map(str::to_string);

        Self {
            event_type,
            event_index,
            timestamp,
            value,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StreamControl {
    pub stream_next_offset: Option<String>,
    pub stream_cursor: Option<String>,
    pub up_to_date: bool,
    pub stream_closed: bool,
}

impl StreamControl {
    pub fn from_value(value: &serde_json::Value) -> Self {
        Self {
            stream_next_offset: value
                .get("streamNextOffset")
                .and_then(|offset| offset.as_str())
                .map(str::to_string),
            stream_cursor: value
                .get("streamCursor")
                .and_then(|cursor| cursor.as_str())
                .map(str::to_string),
            up_to_date: value
                .get("upToDate")
                .and_then(|up_to_date| up_to_date.as_bool())
                .unwrap_or(false),
            stream_closed: value
                .get("streamClosed")
                .and_then(|stream_closed| stream_closed.as_bool())
                .unwrap_or(false),
        }
    }
}
