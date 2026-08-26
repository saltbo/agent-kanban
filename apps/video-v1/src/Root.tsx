import { Composition } from "remotion";
import { ensureFonts } from "./fonts";
import { PROMO_DURATION, PROMO_FPS, PROMO_HEIGHT, PROMO_WIDTH, PromoVideo } from "./PromoVideo";

ensureFonts();

export const Root: React.FC = () => {
  return (
    <Composition id="PromoVideo" component={PromoVideo} durationInFrames={PROMO_DURATION} fps={PROMO_FPS} width={PROMO_WIDTH} height={PROMO_HEIGHT} />
  );
};
