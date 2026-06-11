import time
from uuid import uuid4
from typing import Dict, List, Literal, Optional
from pydantic import BaseModel, Field


class DetectionEvent(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    timestamp: float = Field(default_factory=time.time)
    source: Literal["cv", "audio", "behavior"]
    type: str
    confidence: float
    metadata: Dict = {}


class Explanation(BaseModel):
    summary: str
    evidence_for: List[str]
    evidence_against: List[str]
    confidence: float
    confidence_trend: Literal["increasing", "decreasing", "stable"]
    threat_level: Literal["low", "medium", "high", "critical"]
    open_questions: List[str]
    recommended_action: str


class Activity(BaseModel):
    id: str
    started_at: float
    closed_at: Optional[float] = None
    status: Literal["active", "closed"]
    events: List[DetectionEvent] = []
    latest_explanation: Optional[Explanation] = None
    summary: Optional[Explanation] = None
    camera_id: Optional[str] = None  # session_id of originating camera; None for uploaded video
