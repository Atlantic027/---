Source: UCI Pen-Based Recognition of Handwritten Digits, test split.
Alpaydin, E. & Alimoglu, F. (1996). DOI: https://doi.org/10.24432/C5MG6K
License: CC BY 4.0 https://creativecommons.org/licenses/by/4.0/
Dataset metadata/license: https://archive.ics.uci.edu/dataset/81/pen+based+recognition+of+handwritten+digits

The test split contains 3,498 real tablet-written digits from 14 writers
independent of the dataset's training writers. Each digit is resampled by UCI
to 8 ordered (x,y) points in 0..100, followed by the class label.
Test adaptation: y is flipped to canvas coordinates, successive points are
joined into a stroke. Original pen-up information and aspect ratio are not
fully retained in these 8-point features. This is a domain-shift test, not an
MNIST benchmark or an estimate of classroom-user accuracy.

The recognizer receives only coordinates, never the class label. All rows,
including failures, are retained. Evaluation writes per-row predictions,
per-class counts, and failed row IDs to evaluation.json. Multi-digit tests
compose independently collected digits by translating coordinates; they are
not naturally collected multi-digit handwriting. The minus fixture is synthetic.
