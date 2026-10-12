import React from "react";
import { Composition } from "remotion";
import { FaceScan, CameraFlash, BrowseTiles } from "./Icons";

// Button icons, rendered at 3x (72 px) and shown at 24 px. Transparent background.
export const Root: React.FC = () => (
  <>
    <Composition id="FaceScan" component={FaceScan} durationInFrames={72} fps={30} width={72} height={72} />
    <Composition id="CameraFlash" component={CameraFlash} durationInFrames={66} fps={30} width={72} height={72} />
    <Composition id="BrowseTiles" component={BrowseTiles} durationInFrames={72} fps={30} width={72} height={72} />
  </>
);
